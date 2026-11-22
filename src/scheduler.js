// מנוע התזכורות (רץ כל 10 דקות). כל התראה מופיעה בפעמון במערכת, ונשלחת גם במייל אם חובר שירות מייל.
// לא נשלחות התראות בשבת ובשישי אחרי 12:00.
const { db, getSetting, now, today, heDate } = require('./db');
const { queueEmail, flushOutbox, processCallQueue, markUnanswered } = require('./integrations');

const OPEN = "('new','in_progress','waiting')";
const CASE_SQL = `SELECT c.*, ct.full_name, ct.phone1, s.name source_name,
  (SELECT COALESCE(SUM(amount),0) FROM return_events e WHERE e.case_id = c.id) total
  FROM cases c JOIN contacts ct ON ct.id = c.contact_id LEFT JOIN sources s ON s.id = c.source_id`;

function quietTime(d = new Date()) {
  const day = d.getDay(); // 5 = שישי, 6 = שבת
  return day === 6 || (day === 5 && d.getHours() >= 12);
}
const workDayOK = (d = new Date()) => d.getDay() <= 4; // א'–ה'

// התראה אחת לכל מפתח; מייל נוצר רק כשההתראה חדשה
function notify(userId, caseId, kind, message, dedupKey, emailBody) {
  const r = db.prepare('INSERT OR IGNORE INTO notifications (user_id, case_id, kind, message, dedup_key) VALUES (?,?,?,?,?)').run(userId, caseId, kind, message, dedupKey);
  if (r.changes && userId && emailBody !== false) {
    const u = db.prepare('SELECT full_name, email FROM users WHERE id = ? AND active = 1').get(userId);
    if (u && u.email) queueEmail({ userId, toEmail: u.email, subject: message.split('\n')[0].slice(0, 90), body: `שלום ${u.full_name},\n\n${emailBody || message}\n\nבברכה,\n${getSetting('org_name')}` });
  }
  return r.changes;
}
const admins = () => db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all().map((u) => u.id);
const line = (c) => `• ${c.full_name || ''}${c.phone1 ? ' – ' + c.phone1 : ''} – ₪${Math.round(c.total)}${c.source_name ? ' – ' + c.source_name : ''}${c.next_followup_date ? ' – מעקב ' + heDate(c.next_followup_date) + (c.followup_time ? ' ' + c.followup_time : '') : ''}`;

function runReminders(force = false) {
  const t = today(), ts = now(), d = new Date(), hour = d.getHours();
  let created = 0;

  // 1. ממתינים שהגיע מועדם חוזרים לרשימה הפעילה
  const due = db.prepare(`${CASE_SQL} WHERE c.status = 'waiting' AND c.next_followup_date IS NOT NULL AND c.next_followup_date <= ?`).all(t);
  db.transaction(() => {
    for (const c of due) {
      db.prepare("UPDATE cases SET status='in_progress', updated_at=? WHERE id=?").run(ts, c.id);
      db.prepare("INSERT INTO actions (case_id, type, text, old_value, new_value, created_at) VALUES (?, 'status', ?, 'waiting', 'in_progress', ?)")
        .run(c.id, `הגיע מועד המעקב (${heDate(c.next_followup_date)}) – התיק חזר אוטומטית לרשימת המעקב הפעילה`, ts);
      created += notify(c.assigned_user_id, c.id, 'followup_due', `הגיע מועד המעקב: ${c.full_name || ''}`, `due-${c.id}-${c.next_followup_date}`, false);
    }
  })();
  if (quietTime(d) && !force) return { returnedToActive: due.length, notificationsCreated: created };

  const workers = db.prepare('SELECT * FROM users WHERE active = 1').all();
  const morning = +getSetting('morning_hour') || 8, nudge = +getSetting('nudge_hour') || 13;

  // 2. מייל בוקר "היום שלך"
  if ((hour >= morning && workDayOK(d)) || force) {
    for (const u of workers) {
      const list = db.prepare(`${CASE_SQL} WHERE c.assigned_user_id = ? AND c.status IN ('new','in_progress') AND (c.next_followup_date IS NULL OR c.next_followup_date <= ?) ORDER BY c.next_followup_date`).all(u.id, t);
      if (!list.length) continue;
      const late = list.filter((c) => c.next_followup_date && c.next_followup_date < t);
      const todayL = list.filter((c) => c.next_followup_date === t);
      const fresh = list.filter((c) => !c.next_followup_date);
      let body = `התוכנית שלך להיום (${heDate(t)}):\n`;
      if (todayL.length) body += `\nלדבר היום (${todayL.length}):\n${todayL.map(line).join('\n')}\n`;
      if (late.length) body += `\nבאיחור (${late.length}):\n${late.map(line).join('\n')}\n`;
      if (fresh.length) body += `\nחדשים שעדיין לא נוצר איתם קשר (${fresh.length}):\n${fresh.map(line).join('\n')}\n`;
      created += notify(u.id, null, 'morning', `היום שלך: ${todayL.length} לדבר היום, ${late.length} באיחור, ${fresh.length} חדשים`, `morning-${u.id}-${t}`, body);
    }
  }

  // 2ב. דשבורד יומי למנהל: מצב לפי סוג קובץ ולפי עובד
  if ((hour >= morning && workDayOK(d)) || force) {
    const yest = (() => { const y = new Date(d); y.setDate(y.getDate() - 1); return y.toISOString().slice(0, 10); })();
    const srcs = db.prepare(`SELECT COALESCE(s.name,'ללא סוג') name, u.full_name worker,
        SUM(CASE WHEN c.status IN ${OPEN} THEN 1 ELSE 0 END) open_n,
        COALESCE(SUM(CASE WHEN c.status IN ${OPEN} THEN (SELECT SUM(amount) FROM return_events e WHERE e.case_id = c.id) END),0) open_amt,
        SUM(CASE WHEN c.status IN ('new','in_progress') AND c.next_followup_date < ? THEN 1 ELSE 0 END) late_n,
        SUM(CASE WHEN c.status = 'new' THEN 1 ELSE 0 END) new_n
      FROM cases c LEFT JOIN sources s ON s.id = c.source_id LEFT JOIN users u ON u.id = s.default_assignee_id GROUP BY c.source_id ORDER BY open_amt DESC`).all(t);
    const wk = db.prepare(`SELECT u.full_name,
        (SELECT COUNT(*) FROM cases c WHERE c.assigned_user_id = u.id AND c.status IN ${OPEN}) open_n,
        (SELECT COUNT(*) FROM cases c WHERE c.assigned_user_id = u.id AND c.status IN ('new','in_progress') AND c.next_followup_date < ?) late_n,
        (SELECT COUNT(*) FROM actions a WHERE a.user_id = u.id AND a.type IN ('call','call_no_answer') AND substr(a.created_at,1,10) = ?) calls_y
      FROM users u WHERE u.active = 1 ORDER BY u.full_name`).all(t, yest);
    const resolvedY = db.prepare("SELECT COUNT(*) n, COALESCE(SUM((SELECT SUM(amount) FROM return_events e WHERE e.case_id = c.id)),0) amt FROM cases c WHERE c.status = 'resolved' AND substr(c.resolved_at,1,10) = ?").get(yest);
    if (srcs.length) {
      const tot = srcs.reduce((a, r) => ({ n: a.n + r.open_n, amt: a.amt + r.open_amt, late: a.late + r.late_n }), { n: 0, amt: 0, late: 0 });
      const body = `דשבורד יומי – ${heDate(t)}\n\n` +
        `סה"כ: ${tot.n} תיקים פתוחים · ₪${Math.round(tot.amt).toLocaleString('he-IL')} · ${tot.late} באיחור\n` +
        `אתמול הוסדרו ${resolvedY.n} תיקים (₪${Math.round(resolvedY.amt).toLocaleString('he-IL')})\n\n` +
        `לפי סוג קובץ:\n` + srcs.map((r) => `• ${r.name} (${r.worker || 'ללא אחראי'}): ${r.open_n} פתוחים, ₪${Math.round(r.open_amt).toLocaleString('he-IL')}, ${r.new_n} חדשים, ${r.late_n} באיחור`).join('\n') +
        `\n\nלפי עובד:\n` + wk.map((w) => `• ${w.full_name}: ${w.open_n} פתוחים, ${w.late_n} באיחור, ${w.calls_y} שיחות אתמול`).join('\n');
      for (const a of admins()) created += notify(a, null, 'dashboard', `דשבורד יומי: ${tot.n} פתוחים · ₪${Math.round(tot.amt).toLocaleString('he-IL')} · ${tot.late} באיחור`, `admindash-${a}-${t}`, body);
    }
  }

  // 3. תזכורת צהריים: יש תיקים להיום ועוד לא תועדה שום שיחה היום
  if ((hour >= nudge && workDayOK(d)) || force) {
    for (const u of workers) {
      const pending = db.prepare(`${CASE_SQL} WHERE c.assigned_user_id = ? AND c.status IN ('new','in_progress') AND c.next_followup_date IS NOT NULL AND c.next_followup_date <= ?
        AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.case_id = c.id AND a.user_id = ? AND substr(a.created_at,1,10) = ?)`).all(u.id, t, u.id, t);
      if (!pending.length) continue;
      const names = pending.slice(0, 5).map((c) => c.full_name).join(', ') + (pending.length > 5 ? ` ועוד ${pending.length - 5}` : '');
      created += notify(u.id, null, 'nudge', `עוד לא דיברת היום עם: ${names}`, `nudge-${u.id}-${t}`, `עוד לא תועדה שיחה היום עם:\n${pending.map(line).join('\n')}`);
    }
  }

  // 4. מועד מעקב עם שעה שעבר ביותר מ-X שעות בלי תיעוד – מייל מיידי
  const urgentH = +getSetting('urgent_hours') || 3;
  const timed = db.prepare(`${CASE_SQL} WHERE c.status IN ('new','in_progress') AND c.next_followup_date = ? AND c.followup_time IS NOT NULL`).all(t);
  for (const c of timed) {
    const [hh, mm] = String(c.followup_time).split(':').map(Number);
    const at = new Date(d); at.setHours(hh || 0, mm || 0, 0, 0);
    if ((d - at) / 36e5 < urgentH) continue;
    const since = `${t} ${String(hh).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}:00`;
    const acted = db.prepare('SELECT 1 FROM actions WHERE case_id = ? AND created_at >= ? AND user_id IS NOT NULL').get(c.id, since);
    if (acted) continue;
    created += notify(c.assigned_user_id, c.id, 'urgent', `דחוף: היית אמור לדבר עם ${c.full_name || ''} ב-${c.followup_time}`, `urgent-${c.id}-${t}`, `היית אמור לדבר היום ב-${c.followup_time} עם:\n${line(c)}\n\nעברו ${urgentH} שעות ולא תועדה שיחה.`);
  }

  // 5. תיק חדש שלא נוצר בו קשר תוך X ימים
  const newDays = +getSetting('new_contact_days') || 3;
  const untouched = db.prepare(`${CASE_SQL} WHERE c.status = 'new' AND julianday(?) - julianday(c.created_at) >= ?`).all(ts, newDays);
  for (const c of untouched) created += notify(c.assigned_user_id, c.id, 'stale', `תיק חדש בלי קשר ${newDays} ימים: ${c.full_name || ''}`, `new-${c.id}`, `עדיין לא נוצר קשר עם:\n${line(c)}`);

  // 6. תיק בטיפול שלא טופל X ימים
  const days = Math.max(1, +getSetting('stale_days') || 7);
  const stale = db.prepare(`${CASE_SQL} WHERE c.status = 'in_progress' AND julianday(?) - julianday(COALESCE(c.last_action_at, c.created_at)) >= ?`).all(ts, days);
  for (const c of stale) created += notify(c.assigned_user_id, c.id, 'stale', `לא טופל ${days} ימים: ${c.full_name || ''}`, `stale-${c.id}-${String(c.last_action_at || c.created_at).slice(0, 10)}`, `התיק לא טופל ${days} ימים או יותר:\n${line(c)}`);

  // 7. הסלמה למנהל: תיקים באיחור של X ימים – מייל סיכום אחד ביום
  const esc = +getSetting('escalate_days') || 7;
  if (workDayOK(d) || force) {
    const late = db.prepare(`${CASE_SQL} WHERE c.status IN ('new','in_progress') AND c.next_followup_date IS NOT NULL AND julianday(?) - julianday(c.next_followup_date) >= ?`).all(t, esc);
    if (late.length) {
      const byUser = {};
      for (const c of late) { const n = (db.prepare('SELECT full_name FROM users WHERE id = ?').get(c.assigned_user_id) || {}).full_name || 'ללא מטפל'; (byUser[n] = byUser[n] || []).push(c); }
      const body = `תיקים באיחור של ${esc} ימים ומעלה:\n` + Object.entries(byUser).map(([n, l]) => `\n${n} (${l.length}):\n${l.map(line).join('\n')}`).join('\n');
      for (const a of admins()) created += notify(a, null, 'escalation', `הסלמה: ${late.length} תיקים באיחור של ${esc}+ ימים`, `esc-${a}-${t}`, body);
    }
  }

  // 8. סיכום שבועי למנהל – יום שישי
  if (d.getDay() === 5 || force) {
    const rows = db.prepare(`SELECT COALESCE(s.name,'ללא סוג') name, u.full_name worker,
        SUM(CASE WHEN c.status IN ${OPEN} THEN 1 ELSE 0 END) open_n,
        SUM(CASE WHEN c.status = 'resolved' AND c.resolved_at >= date(?, '-7 day') THEN 1 ELSE 0 END) done_week
      FROM cases c LEFT JOIN sources s ON s.id = c.source_id LEFT JOIN users u ON u.id = s.default_assignee_id GROUP BY c.source_id`).all(t);
    if (rows.length) {
      const body = 'סיכום שבועי לפי סוג קובץ:\n\n' + rows.map((r) => `• ${r.name} (${r.worker || '—'}): ${r.open_n} פתוחים, ${r.done_week} הוסדרו השבוע`).join('\n');
      for (const a of admins()) created += notify(a, null, 'weekly', 'סיכום שבועי – החזרות הוראות קבע', `weekly-${a}-${t}`, body);
    }
  }
  return { returnedToActive: due.length, notificationsCreated: created };
}

async function tick() {
  try {
    runReminders();
    require('./automations').runAll();
    try { require('./yemot').sweepMissingFiles(); } catch (_) { /* */ } // תזכורות, הודעה חודשית, תוקף – מכניסים לתור; השליחה בחלון השליחה
    await flushOutbox();
    await processCallQueue();
    markUnanswered();
    require('./integrations').retryUnanswered();
  } catch (e) {
    console.error('[scheduler]', e);
  }
}
function start() { tick(); setInterval(tick, 10 * 60 * 1000); }

module.exports = { start, runReminders, tick, quietTime };
