// אוטומציות: תזכורות כשאין התקדמות, הודעה חודשית למי שאין לו אמצעי תשלום, התראה על תוקף שעומד לפוג.
// הכל רק מכניס הודעות לתור; השליחה בפועל נעשית ע"י ימות המשיח בחלון השליחה, ונרשמת רק אם ימות אישרו.
const { db, getSetting, now, today } = require('./db');
const M = require('./messaging');

const daysBetween = (a, b) => (new Date(b.replace(' ', 'T')) - new Date(a.replace(' ', 'T'))) / 864e5;
const PROGRESS_TYPES = "('call','call_no_answer','note','payment_promise','payment','meeting','email','sms','status','followup','contact','assign')";

// ---------- 7. תזכורות כשאין התקדמות ----------
// מחזיר רשימת תיקים שאמורה להישלח להם תזכורת עכשיו (גם לתצוגה במסך הבקרה)
function dueReminders() {
  const out = [];
  const sources = db.prepare('SELECT * FROM sources WHERE active = 1').all();
  for (const s of sources) {
    const cfg = M.sourceConfig(s);
    if (!cfg.reminders_enabled) continue;
    const cases = db.prepare("SELECT * FROM cases WHERE source_id = ? AND status IN ('new','in_progress')").all(s.id);
    for (const c of cases) {
      if (c.next_followup_date && c.next_followup_date > today()) continue; // נקבע מעקב עתידי = יש טיפול
      // ההודעה הידנית האחרונה שכללה את התיק
      const manual = db.prepare(`SELECT * FROM voice_calls WHERE trigger = 'manual' AND status NOT IN ('cancelled','failed','queued','sending')
        AND (case_id = ? OR case_ids LIKE ?) ORDER BY id DESC LIMIT 1`).get(c.id, `%${c.id}%`);
      if (!manual || !JSON.parse(manual.case_ids || `[${manual.case_id}]`).includes(c.id)) continue;
      if (manual.digit_pressed) continue; // האדם הגיב (השאיר הודעה / עבר למשרד) – לא מתזכרים
      // התקדמות בטיפול אחרי ההודעה: פעולה של עובד
      const progress = db.prepare(`SELECT MAX(created_at) t FROM actions WHERE case_id = ? AND user_id IS NOT NULL AND type IN ${PROGRESS_TYPES} AND created_at > ?`).get(c.id, manual.created_at).t;
      if (progress) continue;
      const reminders = db.prepare(`SELECT * FROM voice_calls WHERE trigger = 'auto_reminder' AND (case_id = ? OR case_ids LIKE ?) AND created_at > ? AND status <> 'cancelled' ORDER BY id`).all(c.id, `%${c.id}%`, manual.created_at)
        .filter((r) => JSON.parse(r.case_ids || `[${r.case_id}]`).includes(c.id));
      if (reminders.some((r) => ['queued', 'sending'].includes(r.status))) continue;
      if (reminders.length >= +cfg.reminder_max) continue;
      // בסיס החישוב: ההודעה הידנית האחרונה, או הטיפול האחרון (לפי ההגדרה)
      let base = reminders.length ? reminders[reminders.length - 1].created_at : manual.created_at;
      if (cfg.reminder_base === 'action' && c.last_action_at && c.last_action_at > base) base = c.last_action_at;
      if (daysBetween(base, now()) < +cfg.reminder_days) continue;
      out.push({ case_id: c.id, contact_id: c.contact_id, source_id: s.id, reminder_no: reminders.length + 1, base });
    }
  }
  return out;
}
function runReminders() {
  const due = dueReminders();
  const mode = getSetting('send_mode') || 'unified';
  const groups = new Map();
  for (const d of due) {
    const key = mode === 'unified' ? `c${d.contact_id}` : `k${d.case_id}`;
    if (!groups.has(key)) groups.set(key, { contact_id: d.contact_id, caseIds: [], reminder_no: d.reminder_no });
    const g = groups.get(key); g.caseIds.push(d.case_id); g.reminder_no = Math.max(g.reminder_no, d.reminder_no);
  }
  let queued = 0;
  for (const g of groups.values()) {
    const r = M.queueMessage(g.contact_id, { caseIds: g.caseIds, trigger: 'auto_reminder', reminderNo: g.reminder_no });
    if (r.id) queued++;
  }
  return { due: due.length, queued };
}

// ---------- 8. הודעה חודשית למי שאין לו אמצעי תשלום ----------
// "אין אמצעי תשלום" = תיק פתוח בסוג קובץ של מעקב אמצעי תשלום. ברגע שהתיק נסגר (אמצעי תשלום הוסדר) – יוצא מהרשימה.
function noMethodPeople() {
  return db.prepare(`SELECT DISTINCT ct.id contact_id, ct.full_name, ct.phone1, ct.external_id, c.id case_id, c.source_id, c.assigned_user_id
    FROM cases c JOIN sources s ON s.id = c.source_id JOIN contacts ct ON ct.id = c.contact_id
    WHERE s.kind = 'payment_methods' AND s.active = 1 AND c.status IN ('new','in_progress','waiting') GROUP BY ct.id`).all();
}
function runMonthly(force = false) {
  if (getSetting('monthly_enabled') !== '1' && !force) return { skipped: 'disabled' };
  const day = +(getSetting('monthly_day') || 1);
  const d = new Date();
  if (d.getDate() < day && !force) return { skipped: 'not_yet' };
  const period = today().slice(0, 7);
  let queued = 0;
  for (const p of noMethodPeople()) {
    const key = `nomethod-${p.contact_id}-${period}`;
    if (db.prepare('SELECT 1 FROM auto_sends WHERE key = ?').get(key)) continue; // כבר נשלח החודש
    const r = M.queueMessage(p.contact_id, { caseIds: [p.case_id], trigger: 'monthly_no_method' });
    if (r.id) { db.prepare('INSERT INTO auto_sends (key, contact_id, kind, voice_call_id) VALUES (?,?,?,?)').run(key, p.contact_id, 'monthly_no_method', r.id); queued++; }
  }
  return { queued };
}

// ---------- 9. אמצעי תשלום שעומד לפוג ----------
// תוקף מגיע רק מקבצי הספק (עמודת "תוקף"). נשמר רק חודש/שנה – לא פרטי כרטיס.
function parseExpiry(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})\s*[\/\-.]\s*(\d{2,4})$/);
  if (m) { let y = +m[2]; if (y < 100) y += 2000; const mo = +m[1]; if (mo < 1 || mo > 12) return null; const last = new Date(y, mo, 0); return `${y}-${String(mo).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`; }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
// התוקף העדכני של כל אדם = מהשורה האחרונה שנקלטה עם תוקף
function expiringList(withinDays = 60) {
  const rows = db.prepare(`SELECT e.contact_id, e.expiry, e.id, e.case_id, ct.full_name, ct.phone1, ct.external_id, c.source_id, c.assigned_user_id
    FROM return_events e JOIN contacts ct ON ct.id = e.contact_id JOIN cases c ON c.id = e.case_id
    WHERE e.expiry IS NOT NULL AND e.expiry <> '' AND e.id IN (SELECT MAX(id) FROM return_events WHERE expiry IS NOT NULL AND expiry <> '' GROUP BY contact_id, COALESCE(charge_item, ''))`).all();
  const t = today();
  return rows.map((r) => ({ ...r, expiry_date: parseExpiry(r.expiry) })).filter((r) => r.expiry_date)
    .map((r) => ({ ...r, days_left: Math.round(daysBetween(t + ' 00:00:00', r.expiry_date + ' 00:00:00')) }))
    .filter((r) => r.days_left <= withinDays).sort((a, b) => a.days_left - b.days_left);
}
function runExpiry(force = false) {
  if (getSetting('expiry_enabled') !== '1' && !force) return { skipped: 'disabled' };
  const thresholds = String(getSetting('expiry_days') || '30,7').split(',').map((x) => +x.trim()).filter((x) => x > 0).sort((a, b) => b - a);
  let queued = 0;
  for (const r of expiringList(Math.max(...thresholds, 0))) {
    if (r.days_left < 0) continue; // כבר פג – לא שולחים "עומד לפוג"
    const th = thresholds.filter((x) => r.days_left <= x).pop(); // הסף הקטן ביותר שהגענו אליו
    if (th == null) continue;
    const key = `expiry-${r.contact_id}-${r.expiry_date}-${th}`;
    if (db.prepare('SELECT 1 FROM auto_sends WHERE key = ?').get(key)) continue;
    const [y, mo] = r.expiry_date.split('-');
    const q = M.queueMessage(r.contact_id, { caseIds: [r.case_id], trigger: 'expiry', expiry: `חודש ${+mo} שנת ${y}` });
    if (q.id) { db.prepare('INSERT INTO auto_sends (key, contact_id, kind, voice_call_id) VALUES (?,?,?,?)').run(key, r.contact_id, 'expiry', q.id); queued++; }
  }
  return { queued };
}

function runAll() {
  const out = {};
  try { out.reminders = runReminders(); } catch (e) { out.reminders = { error: e.message }; }
  try { out.monthly = runMonthly(); } catch (e) { out.monthly = { error: e.message }; }
  try { out.expiry = runExpiry(); } catch (e) { out.expiry = { error: e.message }; }
  return out;
}

module.exports = { dueReminders, runReminders, noMethodPeople, runMonthly, expiringList, runExpiry, runAll, parseExpiry };
