// אינטגרציות חיצוניות: מייל (SMTP) וחיוג אוטומטי.
// שום דבר לא מוצג כ"פעיל" עד שהוגדר ונבדק בהצלחה.
const nodemailer = require('nodemailer');
const { db, getSetting, setSetting, now } = require('./db');

function emailStatus() {
  const provider = getSetting('email_provider') || (getSetting('smtp_host') ? 'smtp' : '');
  const from = getSetting('smtp_from');
  const ready = provider === 'brevo' ? !!(getSetting('brevo_api_key') && from) : !!(getSetting('smtp_host') && from);
  if (!ready) return { state: 'not_configured', label: 'לא מחובר – יש לחבר שירות מייל (Brevo)' };
  if (getSetting('email_enabled') !== '1') return { state: 'configured', label: 'הוגדר – טרם נבדק בהצלחה / כבוי' };
  return { state: 'active', label: 'פעיל – מיילים נשלחים בפועל' };
}

function transporter() {
  return nodemailer.createTransport({
    host: getSetting('smtp_host'),
    port: +getSetting('smtp_port') || 587,
    secure: getSetting('smtp_secure') === '1',
    auth: getSetting('smtp_user') ? { user: getSetting('smtp_user'), pass: getSetting('smtp_pass') } : undefined,
  });
}

// שליחה בפועל: Brevo (ממשק HTTP – עובד גם בשרתים שחוסמים SMTP) או SMTP רגיל
async function sendMail(to, subject, text) {
  const provider = getSetting('email_provider') || 'smtp';
  if (provider === 'brevo') {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': getSetting('brevo_api_key'), 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { email: getSetting('smtp_from'), name: getSetting('email_from_name') || getSetting('org_name') }, to: [{ email: to }], subject, textContent: text }),
    });
    if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return;
  }
  await transporter().sendMail({ from: getSetting('smtp_from'), to, subject, text });
}

async function testEmail(to) {
  await sendMail(to, 'בדיקת חיבור – מערכת החזרות הוראות קבע', 'אם קיבלת הודעה זו, חיבור המייל פועל.');
  setSetting('email_enabled', '1');
}

// יצירת טיוטת מייל בתיבת היוצא. נשלחת בפועל רק אם המייל פעיל.
function queueEmail({ userId, toEmail, subject, body }) {
  return db.prepare('INSERT INTO email_outbox (to_user_id, to_email, subject, body) VALUES (?,?,?,?)').run(userId || null, toEmail || null, subject, body).lastInsertRowid;
}

async function flushOutbox() {
  if (emailStatus().state !== 'active') return { sent: 0, skipped: 'email_not_active' };
  const rows = db.prepare("SELECT * FROM email_outbox WHERE status IN ('draft','queued') AND to_email IS NOT NULL AND to_email <> '' LIMIT 50").all();
  let sent = 0;
  for (const r of rows) {
    try {
      await sendMail(r.to_email, r.subject, r.body);
      db.prepare("UPDATE email_outbox SET status='sent', sent_at=?, error=NULL WHERE id=?").run(now(), r.id);
      sent++;
    } catch (e) {
      db.prepare("UPDATE email_outbox SET status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 500), r.id);
    }
  }
  return { sent };
}

// ---- חיוג אוטומטי עם הודעה מוקלטת ----
// התשתית: תור שיחות (call_queue) + מתאם ספק. ספקים אפשריים: Twilio, ימות המשיח, Call2All וכד'.
// כל עוד לא הוגדר ספק וכתובת API – השיחות נשמרות בתור במצב "ממתין לחיבור ספק" ולא מתבצעת שום שיחה.
function phoneStatus() {
  if (getSetting('yemot_system') && getSetting('yemot_password')) {
    if (getSetting('yemot_verified') !== '1') return { state: 'configured', label: 'ימות המשיח הוגדר – יש ללחוץ "בדיקת חיבור והתקנת השלוחה"' };
    return { state: 'active', label: 'ימות המשיח מחובר – שיחות יוצאות בפועל' };
  }
  const provider = getSetting('phone_provider');
  const url = getSetting('phone_api_url');
  if (!provider || !url) return { state: 'not_configured', label: 'לא מחובר – נדרש ספק חיוג אוטומטי (ראו הגדרות)' };
  return { state: 'configured', label: `ספק "${provider}" הוגדר – שליחה דרך Webhook` };
}

// נוסח ההודעה הקולית לפי סוג הקובץ, עם תפריט: 1 נדרים פלוס, 2 הקלטת הודעה למזכירות, 3 תזכורת בעוד כמה ימים
// סדר ההקראה: שם → סכום → סיווג/סעיף
const DEFAULT_VOICE = 'שלום וברכה [שם]. הוראת הקבע שלך לא כובדה, והתשלום על סך [סכום] עבור [סעיף] לא הושלם. נשמח שתסדיר את התשלום בהקדם.';
const OLD_DEFAULTS = ['שלום [שם], כאן ישיבת נתיבות שלום סלונים. הוראת הקבע שלך עבור [סעיף] בסך [סכום] חזרה מהבנק. נודה לך אם תטפל בזה בהקדם.',
  'שלום וברכה, כאן ישיבת סלונים. הוראת הקבע שלך עבור [סעיף] בסך [סכום] חזרה מהבנק. נודה לך אם תטפל בזה בהקדם.'];
// ההקראה האישית: שם, סעיף חיוב וסכום – נלקחים אוטומטית מהתיק
function voiceText(kase) {
  const src = kase.source_id ? db.prepare('SELECT * FROM sources WHERE id = ?').get(kase.source_id) : null;
  const custom = getSetting('phone_message');
  const srcMsg = src && src.voice_message && !OLD_DEFAULTS.includes(src.voice_message.trim()) ? src.voice_message : null;
  const base = srcMsg || (custom && custom.includes('[') && !OLD_DEFAULTS.includes(custom.trim()) ? custom : DEFAULT_VOICE);
  const total = Math.round(kase.total_amount || 0);
  const amount = total ? `${total} שקלים` : '';
  const items = db.prepare('SELECT DISTINCT charge_item FROM return_events WHERE case_id = ? AND charge_item IS NOT NULL').all(kase.id).map((r) => r.charge_item);
  const item = items.length ? items.join(' ו') : (src && src.name) || '';
  let body = base.replace(/\[שם\]/g, kase.full_name || '');
  if (!amount) body = body.replace(/\s*(בסך|של)\s*\[סכום\]/g, '');
  if (!item) body = body.replace(/[,\s]*עבור\s*\[סעיף\]/g, '');
  return body.replace(/\[סכום\]/g, amount).replace(/\[סעיף\]/g, item).replace(/\s+/g, ' ').trim();
}
// הודעה יוצאת: הגוף + הזמנה לחזור לקו הישיבה (שם מחכה התפריט האישי)
function outboundText(body, srcId) {
  const src = srcId ? db.prepare('SELECT * FROM sources WHERE id = ?').get(srcId) : null;
  const line = (src && src.callback_phone) || getSetting('yemot_system') || '';
  const spoken = line.replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d+)$/, '$1 $2 $3');
  return `${body} להשארת הודעה או למעבר למשרדי הישיבה, חייגו ${spoken}. תודה ותזכו למצוות.`;
}
// התפריט בשיחה נכנסת לקו הישיבה
function menuText(body, srcId) {
  const src = srcId ? db.prepare('SELECT * FROM sources WHERE id = ?').get(srcId) : null;
  const days = (src && src.callback_days) || 3;
  return `${body} להשארת הודעה הקש 1. למעבר למשרדי הישיבה הקש 2.`;
}
function queueCall({ caseId, phone, userId }) {
  const kase = db.prepare(`SELECT c.*, ct.full_name, (SELECT COALESCE(SUM(amount),0) FROM return_events e WHERE e.case_id = c.id) total_amount
    FROM cases c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?`).get(caseId);
  const msg = voiceText(kase);
  db.prepare('INSERT INTO call_queue (case_id, phone, message_text, created_by) VALUES (?,?,?,?)').run(caseId, phone, msg, userId);
  return db.prepare("INSERT INTO voice_calls (case_id, phone, message_text, created_by, status) VALUES (?,?,?,?, 'queued')").run(caseId, phone, msg, userId).lastInsertRowid;
}

// מתאם כללי: שולח POST JSON לכתובת ה-API של הספק. יש להתאים לפי תיעוד הספק בפועל.
async function processCallQueue() {
  if (phoneStatus().state === 'active') return processYemot();
  if (phoneStatus().state === 'not_configured' || getSetting('yemot_system')) return { processed: 0, skipped: 'phone_not_configured' };
  const rows = db.prepare("SELECT * FROM call_queue WHERE status='pending' LIMIT 20").all();
  let processed = 0;
  for (const r of rows) {
    try {
      const resp = await fetch(getSetting('phone_api_url'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getSetting('phone_api_key')}` },
        body: JSON.stringify({ to: r.phone, from: getSetting('phone_caller_id'), message: r.message_text, reference: `case-${r.case_id}` }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json().catch(() => ({}));
      db.prepare("UPDATE call_queue SET status='sent', provider_ref=?, done_at=? WHERE id=?").run(String(data.id || ''), now(), r.id);
      db.prepare("INSERT INTO actions (case_id, type, text, created_at) VALUES (?, 'auto_call', ?, ?)").run(r.case_id, `נשלחה שיחה אוטומטית למספר ${r.phone}`, now());
      processed++;
    } catch (e) {
      db.prepare("UPDATE call_queue SET status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 500), r.id);
    }
  }
  return { processed };
}

// חלון שליחה (ניתן לשינוי בהגדרות): ימים ושעות
function inSendWindow(d = new Date()) {
  const days = String(getSetting('voice_days') || '0,1,2,3,4').split(',').map(Number);
  const start = +(getSetting('voice_hour_start') || 9), end = +(getSetting('voice_hour_end') || 20);
  const h = d.getHours() + d.getMinutes() / 60;
  // שבת, חג, חול המועד ותשעה באב – אף פעם לא שולחים (גם אם השעה בטווח)
  if (require('./calendar').status(d).blocked) return false;
  return days.includes(d.getDay()) && h >= start && h < end;
}
// שליחת השיחות שבתור דרך ימות המשיח
let yemotBusy = false;
async function processYemot() {
  if (yemotBusy) return { processed: 0, skipped: 'busy' };
  const yemot = require('./yemot');
  if (!inSendWindow()) return { processed: 0, skipped: 'outside_hours' };
  const rows = db.prepare("SELECT * FROM voice_calls WHERE status = 'queued' AND (scheduled_for IS NULL OR scheduled_for <= date('now','localtime')) ORDER BY id LIMIT 300").all();
  if (!rows.length) return { processed: 0 };
  // הודעה על החזרה – רק אם עדיין יש הוראה פתוחה (מי שהסדיר לא יקבל שיחה)
  const stillRelevant = (v) => {
    if (['monthly_no_method', 'expiry', 'warmup'].includes(v.trigger)) return true;
    let ids = []; try { ids = JSON.parse(v.event_ids || '[]'); } catch (_) { ids = []; }
    if (ids.length) return !!db.prepare(`SELECT 1 FROM return_events e JOIN cases c ON c.id = e.case_id WHERE e.id IN (${ids.map(() => '?').join(',')}) AND e.status = 'open' AND c.status IN ('new','in_progress','waiting')`).get(...ids);
    const c = db.prepare('SELECT status FROM cases WHERE id = ?').get(v.case_id);
    return c && ['new', 'in_progress', 'waiting'].includes(c.status);
  };
  const live = [];
  const seen = new Set();
  // שיחה שמחכה לשיחת חימום – יוצאת רק אחרי שהחימום הסתיים (או אחרי 20 דקות)
  const warmDone = (id) => { const w = db.prepare('SELECT status, listen_status, created_at FROM voice_calls WHERE id = ?').get(id);
    return !w || w.listen_status || ['replied', 'no_answer', 'failed', 'cancelled'].includes(w.status) || (Date.now() - new Date(String(w.created_at).replace(' ', 'T')).getTime()) > 20 * 60e3; };
  for (const v of rows) {
    if (v.wait_for && !warmDone(v.wait_for)) continue;
    if (!stillRelevant(v)) { db.prepare("UPDATE voice_calls SET status='cancelled', error='הטיפול הושלם לפני השליחה', updated_at=? WHERE id=?").run(now(), v.id); continue; }
    const ph = yemot.normPhone(v.phone);
    // שיחה אחת בכל פעם לכל מספר (שהתפריט יזהה את ההודעה הנכונה)
    if (seen.has(ph) || db.prepare("SELECT 1 FROM voice_calls WHERE replace(replace(phone,'-',''),' ','') = ? AND status IN ('sent','sending') AND julianday('now','localtime') - julianday(updated_at) < 0.03").get(ph)) continue;
    seen.add(ph); live.push(v);
  }
  if (!live.length) return { processed: 0 };
  yemotBusy = true;
  let processed = 0;
  try {
    for (const v of live) db.prepare("UPDATE voice_calls SET status='sending', updated_at=? WHERE id=?").run(now(), v.id);
    // הקלטה מוכנה לכל שיחה לפני החיוג (5 במקביל) – כדי שההודעה תתחיל מיד כשעונים
    if (require('./tts').enabled()) {
      const queue = [...live];
      await Promise.all(Array.from({ length: Math.min(5, queue.length) }, async () => { while (queue.length) await yemot.prepareAudio(queue.shift()); }));
    }
    const phones = live.map((v) => yemot.normPhone(v.phone));
    for (let i = 0; i < phones.length; i += 400) {
      const chunk = phones.slice(i, i + 400);
      const batch = live.filter((x) => chunk.includes(yemot.normPhone(x.phone)));
      try {
        const r = await yemot.bridgeCalls(chunk);
        if (!r.campaignId && r.responseStatus !== 'OK') throw new Error(r.message || 'ימות המשיח לא אישרו את החיוג');
        const errs = r.errors || {};
        for (const v of batch) {
          const e = errs[yemot.normPhone(v.phone)];
          db.prepare('UPDATE voice_calls SET status=?, campaign_id=?, error=?, updated_at=? WHERE id=?').run(e ? 'failed' : 'sent', r.campaignId || null, e || null, now(), v.id);
          if (!e) processed++;
        }
      } catch (e) {
        for (const v of batch) db.prepare("UPDATE voice_calls SET status='failed', error=?, updated_at=? WHERE id=?").run(String(e.message).slice(0, 300), now(), v.id);
      }
    }
  } finally { yemotBusy = false; }
  return { processed };
}
// שיחה שנשלחה ולא נענתה תוך 6 שעות – "לא נענתה"
function markUnanswered() {
  db.prepare("UPDATE voice_calls SET status='no_answer', updated_at=? WHERE status='sent' AND julianday('now','localtime') - julianday(updated_at) > 0.0105").run(now());
  db.prepare("UPDATE voice_calls SET status='failed', error='השליחה לא הושלמה', updated_at=? WHERE status='sending' AND julianday('now','localtime') - julianday(updated_at) > 0.02").run(now());
}

module.exports = { inSendWindow, outboundText, menuText, processYemot, markUnanswered, emailStatus, testEmail, sendMail, queueEmail, flushOutbox, phoneStatus, queueCall, processCallQueue, voiceText };
