// מערכת ניהול החזרות הוראות קבע – ישיבת סלונים
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const ExcelJS = require('exceljs');
const { db, DB_PATH, DATA_DIR, STATUSES, OPEN_STATUSES, getSetting, setSetting, now, today, heDate } = require('./src/db');
const auth = require('./src/auth');
const importer = require('./src/importer');
const integ = require('./src/integrations');
const scheduler = require('./src/scheduler');
const yemot = require('./src/yemot');
const MSG = require('./src/messaging');
const automations = require('./src/automations');
const P = auth.requirePerm;

const app = express();
const PORT = +process.env.PORT || 3000;
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(auth.loadUser);
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
// שליחה מיידית של מה שבתור (במקום לחכות לסבב של 10 דקות)
function sendNow() { setTimeout(() => integ.processCallQueue().catch((e) => console.error('[sendNow]', e)), 100); }
function sendWindow() {
  const cal = require('./src/calendar').status();
  if (cal.blocked) return { now: false, label: `${cal.reason} – השיחה תצא אוטומטית אחרי ${cal.reason === 'שבת' ? 'השבת' : cal.reason}, בחלון השליחה הבא (מ${cal.untilLabel})` };
  const ok = integ.inSendWindow();
  const days = String(getSetting('voice_days') || '0,1,2,3,4').split(',').map((d) => 'אבגדהוש'[+d] + "'").join(' ');
  return ok ? { now: true, label: 'השיחה יוצאת עכשיו' } : { now: false, label: `מחוץ לשעות השליחה (${days} ${getSetting('voice_hour_start') || 9}:00–${getSetting('voice_hour_end') || 20}:00) – תצא אוטומטית בחלון השליחה הבא` };
}
const OPEN_SQL = `('${OPEN_STATUSES.join("','")}')`;

function logAction(caseId, userId, type, text, oldV = null, newV = null) {
  const ts = now();
  db.prepare('INSERT INTO actions (case_id, user_id, type, text, old_value, new_value, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(caseId, userId, type, text, oldV, newV, ts);
  db.prepare('UPDATE cases SET last_action_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, caseId);
}
const userName = (id) => (id ? (db.prepare('SELECT full_name FROM users WHERE id = ?').get(id) || {}).full_name : null);

// ---------- כניסה ----------
app.get('/api/me', (req, res) => {
  const hasAdmin = !!db.prepare("SELECT 1 FROM users WHERE role='admin' AND password_hash IS NOT NULL").get();
  const user = req.user ? { ...req.user, permissions_json: undefined, perms: auth.perms(req.user), canResetPw: ['code', 'google'].includes(req.user.session_via) } : null;
  res.json({ user, needsSetup: !hasAdmin, orgName: getSetting('org_name'), tabIcons: (() => { try { return JSON.parse(getSetting('tab_icons') || '{}'); } catch (_) { return {}; } })(), hasFavicon: !!getSetting('favicon_data'), hebToday: require('./src/calendar').hebDate(new Date()), sendBlock: require('./src/calendar').status(), prefs: { hebDates: getSetting('show_hebrew_dates') !== '0', accent: getSetting('accent_color') || '', adminHome: getSetting('admin_home') || 'control' } });
});

app.post('/api/setup', (req, res) => {
  if (db.prepare("SELECT 1 FROM users WHERE role='admin' AND password_hash IS NOT NULL").get()) return bad(res, 'המערכת כבר הוגדרה');
  const { full_name, username, password, email } = req.body || {};
  if (!full_name || !username || !password || password.length < 8) return bad(res, 'יש למלא שם, שם משתמש וסיסמה באורך 8 תווים לפחות');
  const id = db.prepare("INSERT INTO users (full_name, username, email, password_hash, role) VALUES (?,?,?,?, 'admin')")
    .run(full_name.trim(), username.trim().toLowerCase(), email || null, auth.hashPassword(password)).lastInsertRowid;
  auth.createSession(res, id, SECURE_COOKIE);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = (req.ip || '') + '|' + String(username || '').toLowerCase();
  if (auth.loginRateLimit(key)) return bad(res, 'יותר מדי ניסיונות. נסו שוב בעוד 15 דקות', 429);
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim().toLowerCase());
  if (!u || !auth.verifyPassword(String(password || ''), u.password_hash)) {
    auth.recordFailedLogin(key);
    return bad(res, 'שם משתמש או סיסמה שגויים', 401);
  }
  auth.createSession(res, u.id, SECURE_COOKIE);
  res.json({ ok: true });
});
// ---------- כניסה בלי סיסמה: קוד למייל / חשבון גוגל ----------
// המשתמש מזוהה לפי כתובת המייל שמעודכנת אצלו במסך "עובדים"
const userByEmail = (email) => db.prepare('SELECT * FROM users WHERE lower(trim(email)) = ? AND active = 1').get(String(email || '').trim().toLowerCase());
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
app.get('/api/login/options', (req, res) => {
  res.json({ phone: yemot.configured() && getSetting('yemot_verified') === '1', email: integ.emailStatus().state === 'active', googleClientId: getSetting('google_client_id') || '' });
});
app.post('/api/login/email-code', wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'כתובת מייל לא תקינה');
  if (integ.emailStatus().state !== 'active') return bad(res, 'שליחת מיילים עוד לא מחוברת במערכת. בינתיים נכנסים עם שם משתמש וסיסמה.');
  const key = 'code|' + (req.ip || '') + '|' + email;
  if (auth.loginRateLimit(key)) return bad(res, 'יותר מדי ניסיונות. נסו שוב בעוד 15 דקות', 429);
  auth.recordFailedLogin(key); // סופר בקשות קוד, כדי שלא יציפו מייל
  const u = userByEmail(email);
  if (u) {
    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare('UPDATE login_codes SET used = 1 WHERE user_id = ? AND used = 0').run(u.id);
    db.prepare('INSERT INTO login_codes (user_id, code_hash, expires_at) VALUES (?,?,?)').run(u.id, sha(code), new Date(Date.now() + 10 * 60e3).toISOString());
    try { await integ.sendMail(u.email, `קוד כניסה: ${code}`, `שלום ${u.full_name},\n\nקוד הכניסה שלך למערכת ניהול ההחזרות: ${code}\n\nהקוד בתוקף ל-10 דקות. אם לא ביקשת קוד – אפשר להתעלם מהמייל.`); }
    catch (e) { console.error('[login code]', e.message); return bad(res, 'שליחת המייל נכשלה. נסו שוב או היכנסו עם סיסמה.'); }
  }
  // אותה תשובה גם כשהמייל לא קיים – כדי שאי אפשר יהיה לבדוק אילו מיילים רשומים
  res.json({ ok: true });
}));
function verifyLoginCode(u, codeRaw, res) {
  const code = String(codeRaw || '').replace(/\D/g, '');
  const row = u && db.prepare('SELECT * FROM login_codes WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(u.id);
  if (!row || new Date(row.expires_at) < new Date()) return bad(res, 'הקוד לא תקין או שפג תוקפו. בקשו קוד חדש.', 401);
  if (row.attempts >= 5) { db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(row.id); return bad(res, 'יותר מדי ניסיונות. בקשו קוד חדש.', 429); }
  const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(sha(code)), Buffer.from(row.code_hash));
  if (!ok) { db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id); return bad(res, 'הקוד שגוי', 401); }
  db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(row.id);
  auth.createSession(res, u.id, SECURE_COOKIE, 'code');
  res.json({ ok: true });
}
app.post('/api/login/email-verify', (req, res) => verifyLoginCode(userByEmail((req.body || {}).email), (req.body || {}).code, res));
// ---- קוד בשיחה קולית (ימות המשיח) – לפי הטלפון שמעודכן אצל העובד ----
const userByPhone = (ph) => { const n = yemot.normPhone(ph); return n.length >= 9 ? db.prepare('SELECT * FROM users WHERE active = 1 AND phone IS NOT NULL').all().find((u) => yemot.normPhone(u.phone) === n) : null; };
app.post('/api/login/phone-code', wrap(async (req, res) => {
  const phone = yemot.normPhone((req.body || {}).phone);
  if (!/^0\d{8,9}$/.test(phone)) return bad(res, 'מספר טלפון לא תקין');
  if (!yemot.configured()) return bad(res, 'מערכת הטלפון לא מחוברת. נכנסים עם שם משתמש וסיסמה.');
  const cal = require('./src/calendar').status();
  if (cal.blocked) return bad(res, `עכשיו ${cal.reason} – לא מתקשרים. נכנסים עם שם משתמש וסיסמה.`);
  const key = 'phone|' + (req.ip || '') + '|' + phone;
  if (auth.loginRateLimit(key)) return bad(res, 'יותר מדי ניסיונות. נסו שוב בעוד 15 דקות', 429);
  auth.recordFailedLogin(key);
  const u = userByPhone(phone);
  if (u) {
    // לא יותר מ-3 שיחות קוד ברבע שעה לאותו עובד (חוסך יחידות)
    if (db.prepare("SELECT COUNT(*) n FROM login_codes WHERE user_id = ? AND created_at > datetime('now','localtime','-15 minutes')").get(u.id).n >= 3) return bad(res, 'כבר נשלחו כמה קודים. נסו שוב בעוד רבע שעה.', 429);
    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare('UPDATE login_codes SET used = 1 WHERE user_id = ? AND used = 0').run(u.id);
    db.prepare('INSERT INTO login_codes (user_id, code_hash, expires_at) VALUES (?,?,?)').run(u.id, sha(code), new Date(Date.now() + 10 * 60e3).toISOString());
    const digits = code.split('');
    const parts = ['שלום וברכה', 'קוד הכניסה שלך למערכת הוא', ...digits, 'אני חוזר', ...digits, 'תודה רבה'];
    const w = warmupCase(); const ts = now();
    db.prepare("DELETE FROM voice_calls WHERE trigger = 'login_code' AND julianday('now','localtime') - julianday(created_at) > 0.02").run();
    const id = db.prepare(`INSERT INTO voice_calls (case_id, contact_id, phone, message_text, parts_json, event_ids, case_ids, trigger, status, created_by, created_at, updated_at)
      VALUES (?,?,?, 'קוד כניסה', ?, '[]', '[]', 'login_code', 'sending', ?, ?, ?)`).run(w.caseId, w.contactId, phone, JSON.stringify(parts), u.id, ts, ts).lastInsertRowid;
    try {
      const r = await yemot.bridgeCalls([phone]);
      if (!r.campaignId && r.responseStatus !== 'OK') throw new Error(r.message || 'החיוג לא אושר');
      db.prepare("UPDATE voice_calls SET status='sent', campaign_id=?, updated_at=? WHERE id=?").run(r.campaignId || null, now(), id);
    } catch (e) { db.prepare('DELETE FROM voice_calls WHERE id = ?').run(id); console.error('[login phone]', e.message); return bad(res, 'השיחה לא יצאה. נסו שוב או היכנסו עם סיסמה.'); }
  }
  res.json({ ok: true });
}));
app.post('/api/login/phone-verify', (req, res) => verifyLoginCode(userByPhone((req.body || {}).phone), (req.body || {}).code, res));
app.post('/api/login/google', wrap(async (req, res) => {
  const clientId = getSetting('google_client_id');
  if (!clientId) return bad(res, 'הכניסה עם גוגל עוד לא הוגדרה');
  const cred = String((req.body || {}).credential || '');
  if (!cred) return bad(res, 'חסר אישור מגוגל');
  // אימות האישור מול גוגל: שהוא הונפק לאתר שלנו, שהמייל מאומת ושלא פג תוקפו
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
  const t = await r.json().catch(() => ({}));
  if (!r.ok || t.aud !== clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(t.iss) || String(t.email_verified) !== 'true' || +t.exp * 1000 < Date.now()) return bad(res, 'גוגל לא אישרו את הכניסה. נסו שוב.', 401);
  const u = userByEmail(t.email);
  if (!u) return bad(res, `החשבון ${t.email} לא רשום במערכת. מנהל המערכת צריך לעדכן את המייל הזה אצלך במסך "עובדים".`, 403);
  auth.createSession(res, u.id, SECURE_COOKIE, 'google');
  res.json({ ok: true });
}));
app.post('/api/logout', (req, res) => { auth.destroySession(req, res); res.json({ ok: true }); });

app.post('/api/me/password', auth.requireAuth, (req, res) => {
  const { current, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  // מי שנכנס עכשיו עם קוד (בטלפון/במייל) או עם גוגל – יכול לקבוע סיסמה חדשה בלי הישנה (למשל אם שכח אותה). חלון של 30 דקות מהכניסה
  const fresh = req.user.session_created && (Date.now() - new Date(String(req.user.session_created).replace(' ', 'T')).getTime()) < 30 * 60e3;
  const noCurrent = ['code', 'google'].includes(req.user.session_via) && fresh;
  if (!noCurrent && !auth.verifyPassword(String(current || ''), u.password_hash)) return bad(res, 'הסיסמה הנוכחית שגויה');
  if (!password || password.length < 8) return bad(res, 'סיסמה חדשה – לפחות 8 תווים');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), u.id);
  res.json({ ok: true });
});

// שלוחת ימות המשיח – פתוחה (מאובטחת במפתח סודי שנשלח רק מהשלוחה שלנו)
app.all('/api/yemot/ivr', express.urlencoded({ extended: false }), (req, res) => {
  const q = { ...req.query, ...(req.body || {}) };
  const { key: _k, ...logged } = q;
  console.log('[yemot ivr] in', JSON.stringify(logged));
  let out;
  try {
    const testOn = q.key === getSetting('yemot_ivr_secret') && yemot.normPhone(q.ApiPhone) === yemot.normPhone(getSetting('yemot_test_phone'))
      && Date.now() < +(getSetting('yemot_test_until') || 0);
    if (testOn) {
      const menuTxt = 'זוהי שיחת בדיקה ממערכת ההחזרות של הישיבה להשארת הודעה הקש 1 למעבר למשרדי הישיבה הקש 2';
      if (q.hangup === 'yes') out = 'ok';
      else if (q.rec) { setSetting('yemot_test_rec', `ivr2:/9/rec/${String(q.ApiCallId || '').replace(/[^\w-]/g, '')}.wav`); out = 'id_list_message=t-ההודעה נשמרה הבדיקה עברה בהצלחה&go_to_folder=hangup'; }
      else if (q.menu === '1') out = `read=t-אנא השאירו הודעה לאחר הצליל בסיום הקישו סולמית=rec,no,record,/9/rec,${String(q.ApiCallId || 'test').replace(/[^\w-]/g, '')},no,yes,no,1,180`;
      else if (q.menu === '2') out = `id_list_message=t-מעביר אותך למשרדי הישיבה&routing=${(getSetting('office_phone') || '025804581').replace(/\D/g, '')}`;
      else out = `read=t-${menuTxt}=menu,no,1,1,7,No,yes,no,,1.2,2,,,,no`;
    } else out = yemot.handleIvr(q);
  } catch (e) { console.error('[yemot ivr]', e); out = 'go_to_folder=hangup'; }
  console.log('[yemot ivr] out', out.slice(0, 200));
  res.type('text/plain; charset=utf-8').send(out);
});

// סמל המערכת בכרטיסיית הדפדפן (מועלה בהגדרות)
app.get('/favicon.ico', (req, res) => {
  const d = getSetting('favicon_data');
  const m = d && d.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return res.set('Cache-Control', 'no-cache').type('image/svg+xml').sendFile(path.join(__dirname, 'public', 'favicon.svg'));
  res.set('Cache-Control', 'no-cache').type(m[1]).send(Buffer.from(m[2], 'base64'));
});

app.use('/api', auth.requireAuth);

// ---------- מסך ראשי ----------
app.get('/api/stats', (req, res) => {
  const t = today();
  const sc = scope(req.user);
  const r = db.prepare(`SELECT
      SUM(CASE WHEN status IN ${OPEN_SQL} THEN 1 ELSE 0 END) open_cases,
      SUM(CASE WHEN status='new' THEN 1 ELSE 0 END) new_cases,
      SUM(CASE WHEN status='waiting' THEN 1 ELSE 0 END) waiting_cases,
      SUM(CASE WHEN status IN ('new','in_progress') AND next_followup_date IS NOT NULL AND next_followup_date <= ? THEN 1 ELSE 0 END) due_cases
    FROM cases c WHERE ${sc.sql}`).get(t, ...sc.params);
  const amt = db.prepare(`SELECT COALESCE(SUM(e.amount),0) s, COUNT(*) n FROM return_events e JOIN cases c ON c.id = e.case_id WHERE c.status IN ${OPEN_SQL} AND ${sc.sql}`).get(...sc.params);
  const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE read_at IS NULL AND (user_id = ? OR (user_id IS NULL AND ? = 1))').get(req.user.id, req.user.role === 'admin' ? 1 : 0).n;
  const lastImport = db.prepare('SELECT id, filename, period_label, created_at FROM imports ORDER BY id DESC LIMIT 1').get();
  res.json({ ...r, open_amount: Math.round(amt.s * 100) / 100, open_events: amt.n, unread, lastImport });
});

// מטפל רואה רק תיקים שמשויכים אליו או מסוגי קבצים שנפתחו לו; מנהל רואה הכל
// התיק הפנימי של שיחות החימום לא מוצג באף רשימה
const NOT_WARMUP = (alias) => `${alias}.contact_id NOT IN (SELECT id FROM contacts WHERE external_id = '__warmup__')`;
function scope(user, alias = 'c') {
  if (user.role === 'admin' || auth.can(user, 'all_sources')) return { sql: NOT_WARMUP(alias), params: [] };
  return { sql: `(${alias}.assigned_user_id = ? OR ${alias}.source_id IN (SELECT source_id FROM user_sources WHERE user_id = ?)) AND ${NOT_WARMUP(alias)}`, params: [user.id, user.id] };
}
function canSeeCase(user, caseId) {
  const sc = scope(user);
  return !!db.prepare(`SELECT 1 FROM cases c WHERE c.id = ? AND ${sc.sql}`).get(caseId, ...sc.params);
}

const CASE_LIST_SQL = `
  SELECT c.id, c.status, c.assigned_user_id, u.full_name assignee, c.last_action_at, c.next_followup_date, c.followup_time, c.attempts, c.created_at,
    c.source_id, s.name source_name, s.kind source_kind,
    (SELECT GROUP_CONCAT(ci, ' | ') FROM (SELECT DISTINCT charge_item ci FROM return_events e WHERE e.case_id = c.id AND charge_item IS NOT NULL)) charge_items,
    (SELECT GROUP_CONCAT(pm, ' | ') FROM (SELECT DISTINCT COALESCE(method_status, payment_method) pm FROM return_events e WHERE e.case_id = c.id AND COALESCE(method_status, payment_method) IS NOT NULL)) methods,
    ct.id contact_id, ct.external_id, ct.full_name, ct.phone1, ct.phone2, ct.phone3, ct.city, ct.bad_phones,
    (SELECT COALESCE(SUM(amount),0) FROM return_events e WHERE e.case_id = c.id) total_amount,
    (SELECT COUNT(*) FROM return_events e WHERE e.case_id = c.id) events_count,
    (SELECT GROUP_CONCAT(r, ' | ') FROM (SELECT DISTINCT COALESCE(reason, reason_code) r FROM return_events e WHERE e.case_id = c.id AND COALESCE(reason, reason_code) IS NOT NULL)) reasons
  FROM cases c JOIN contacts ct ON ct.id = c.contact_id LEFT JOIN users u ON u.id = c.assigned_user_id LEFT JOIN sources s ON s.id = c.source_id`;

app.get('/api/cases', (req, res) => {
  const { view = 'active', q = '', assignee = '', status = '', source = '' } = req.query;
  const sc = scope(req.user);
  const where = [sc.sql];
  const params = [...sc.params];
  if (source) { where.push('c.source_id = ?'); params.push(+source); }
  const t = today();
  switch (view) {
    case 'active': where.push("c.status IN ('new','in_progress')"); break;
    case 'new': where.push("c.status = 'new'"); break;
    case 'waiting': where.push("c.status = 'waiting'"); break;
    case 'due': where.push("c.status IN ('new','in_progress') AND c.next_followup_date IS NOT NULL AND c.next_followup_date <= ?"); params.push(t); break;
    case 'today': where.push("c.status IN ('new','in_progress') AND c.next_followup_date = ?"); params.push(t); break;
    case 'late': where.push("c.status IN ('new','in_progress') AND c.next_followup_date IS NOT NULL AND c.next_followup_date < ?"); params.push(t); break;
    case 'uncontacted': where.push("c.status = 'new'"); break;
    case 'open': where.push(`c.status IN ${OPEN_SQL}`); break;
    case 'closed': where.push("c.status IN ('resolved','unresolvable')"); break;
    case 'mine': where.push(`c.status IN ${OPEN_SQL} AND c.assigned_user_id = ?`); params.push(req.user.id); break;
    default: break;
  }
  if (status && STATUSES[status]) { where.push('c.status = ?'); params.push(status); }
  if (assignee === 'none') where.push('c.assigned_user_id IS NULL');
  else if (assignee) { where.push('c.assigned_user_id = ?'); params.push(+assignee); }
  if (q.trim()) {
    const like = `%${q.trim()}%`;
    where.push('(ct.full_name LIKE ? OR ct.external_id LIKE ? OR ct.phone1 LIKE ? OR ct.phone2 LIKE ? OR ct.phone3 LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const sql = `${CASE_LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE c.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
      COALESCE(c.next_followup_date, '9999') , total_amount DESC LIMIT 2000`;
  res.json(db.prepare(sql).all(...params));
});

// כל פעולה על תיק בודקת שהמשתמש רשאי לראות אותו
app.use('/api/cases/:id', (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  if (!canSeeCase(req.user, +req.params.id)) return bad(res, 'התיק לא נמצא או שאין לך הרשאה אליו', 404);
  next();
});

app.get('/api/cases/:id', (req, res) => {
  const c = db.prepare(`${CASE_LIST_SQL} WHERE c.id = ?`).get(+req.params.id);
  if (!c) return bad(res, 'התיק לא נמצא', 404);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.contact_id);
  const events = db.prepare(`SELECT e.*, i.filename, i.period_label FROM return_events e LEFT JOIN imports i ON i.id = e.import_id WHERE e.case_id = ? ORDER BY e.charge_date, e.id`).all(c.id);
  const actions = db.prepare('SELECT a.*, u.full_name user_name FROM actions a LEFT JOIN users u ON u.id = a.user_id WHERE a.case_id = ? ORDER BY a.id DESC').all(c.id);
  const assignments = db.prepare(`SELECT a.*, f.full_name from_name, t.full_name to_name, b.full_name by_name FROM assignments a
    LEFT JOIN users f ON f.id = a.from_user_id LEFT JOIN users t ON t.id = a.to_user_id LEFT JOIN users b ON b.id = a.by_user_id WHERE a.case_id = ? ORDER BY a.id DESC`).all(c.id);
  const otherCases = db.prepare(`SELECT id, status, created_at, resolved_at, (SELECT COALESCE(SUM(amount),0) FROM return_events e WHERE e.case_id = cases.id) total
    FROM cases WHERE contact_id = ? AND id <> ? ORDER BY id DESC`).all(c.contact_id, c.id);
  const calls = db.prepare('SELECT * FROM voice_calls WHERE case_id = ? ORDER BY id DESC').all(c.id);
  res.json({ case: c, contact, events, actions, assignments, otherCases, calls });
});

const ACTION_TYPES = { note: 'הערה', call: 'שיחת טלפון', call_no_answer: 'ניסיון שיחה – אין מענה', email: 'מייל', sms: 'הודעה', meeting: 'פגישה', payment_promise: 'התחייבות לתשלום', payment: 'תשלום התקבל' };

app.post('/api/cases/:id/actions', P('change_status'), (req, res) => {
  const id = +req.params.id;
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  if (!c) return bad(res, 'התיק לא נמצא', 404);
  const { type = 'note', text = '', followup_date } = req.body || {};
  if (!ACTION_TYPES[type]) return bad(res, 'סוג פעולה לא חוקי');
  if (!text.trim() && type !== 'call_no_answer') return bad(res, 'יש לכתוב תיאור לפעולה');
  const tx = db.transaction(() => {
    logAction(id, req.user.id, type, text.trim() || ACTION_TYPES[type]);
    if (c.status === 'new') {
      db.prepare("UPDATE cases SET status='in_progress' WHERE id=?").run(id);
      logAction(id, req.user.id, 'status', 'סטטוס עודכן אוטומטית עם תחילת הטיפול', 'new', 'in_progress');
    }
    if (followup_date) {
      db.prepare('UPDATE cases SET next_followup_date = ? WHERE id = ?').run(followup_date, id);
      logAction(id, req.user.id, 'followup', `נקבע תאריך מעקב: ${heDate(followup_date)}`, c.next_followup_date, followup_date);
    }
    if (!c.assigned_user_id) assign(id, req.user.id, req.user.id, 'שויך אוטומטית למי שתיעד את הפעולה הראשונה');
  });
  tx();
  res.json({ ok: true });
});

app.post('/api/cases/:id/status', P('change_status'), (req, res) => {
  const id = +req.params.id;
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  if (!c) return bad(res, 'התיק לא נמצא', 404);
  const { status, followup_date, note = '', confirm_settled } = req.body || {};
  if (!STATUSES[status]) return bad(res, 'סטטוס לא חוקי');
  if (status === 'waiting') {
    if (!followup_date) return bad(res, 'בסטטוס "ממתין לחודש הבא" חובה לקבוע תאריך מעקב');
    if (followup_date <= today()) return bad(res, 'תאריך המעקב חייב להיות עתידי');
  }
  if (status === 'resolved') {
    if (!confirm_settled) return bad(res, 'לא ניתן לסמן "טופל" ללא אישור שהחוב הוסדר');
    if (!note.trim()) return bad(res, 'יש לפרט כיצד הוסדר החוב (למשל: שולם במזומן / חויב מחדש בהצלחה)');
  }
  if (status === 'unresolvable' && !note.trim()) return bad(res, 'יש לפרט מדוע לא ניתן לטפל בתיק');
  const tx = db.transaction(() => {
    const ts = now();
    const closing = status === 'resolved' || status === 'unresolvable';
    db.prepare('UPDATE cases SET status = ?, resolved_at = ?, next_followup_date = ? WHERE id = ?')
      .run(status, closing ? ts : null, status === 'waiting' ? followup_date : (closing ? null : (followup_date || c.next_followup_date)), id);
    let txt = `סטטוס שונה מ"${STATUSES[c.status]}" ל"${STATUSES[status]}"`;
    if (status === 'waiting') txt += ` – מעקב ב-${heDate(followup_date)}`;
    if (status === 'resolved') txt += ' – אושר שהחוב הוסדר';
    if (note.trim()) txt += `\n${note.trim()}`;
    logAction(id, req.user.id, 'status', txt, c.status, status);
    if (closing) db.prepare("UPDATE return_events SET status='resolved', resolved_at=? WHERE case_id = ? AND status='open'").run(ts, id);
  });
  tx();
  res.json({ ok: true });
});

// סטטוס לכל הוראת קבע בנפרד: סימון שורה כהוסדרה / פתוחה. כשכל השורות הוסדרו – התיק נסגר.
// הודעה קולית על הוראה אחת בלבד (אם יחזור לקו – ישמע את ההודעה הרגילה על כל ההוראות)
// עדכון הוראה קיימת: סעיף חיוב ומועד פקיעת תוקף (בלי להעלות Excel)
app.put('/api/events/:id', P('edit_contacts'), (req, res) => {
  const e = db.prepare('SELECT * FROM return_events WHERE id = ?').get(+req.params.id);
  if (!e || !canSeeCase(req.user, e.case_id)) return bad(res, 'לא נמצא', 404);
  const b = req.body || {};
  const item = b.charge_item != null ? String(b.charge_item).trim() || null : e.charge_item;
  let expiry = e.expiry;
  if (b.expiry_month !== undefined) { const m = String(b.expiry_month || '').match(/^(\d{4})-(\d{2})$/); expiry = m ? `${m[2]}/${m[1].slice(2)}` : null; }
  db.prepare('UPDATE return_events SET charge_item = ?, expiry = ? WHERE id = ?').run(item, expiry, e.id);
  const ch = [item !== e.charge_item ? `סעיף: ${e.charge_item || '—'} ← ${item || '—'}` : '', expiry !== e.expiry ? `תוקף: ${e.expiry || '—'} ← ${expiry || '—'}` : ''].filter(Boolean).join(' · ');
  if (ch) logAction(e.case_id, req.user.id, 'note', `עדכון הוראה: ${ch}`);
  res.json({ ok: true });
});
app.post('/api/events/:id/voice', P('send_voice'), (req, res) => {
  const e = db.prepare('SELECT * FROM return_events WHERE id = ?').get(+req.params.id);
  if (!e || !canSeeCase(req.user, e.case_id)) return bad(res, 'לא נמצא', 404);
  if (e.status !== 'open') return bad(res, 'ההוראה הזו כבר הוסדרה');
  const r = MSG.queueMessage(e.contact_id, { caseIds: [e.case_id], eventIds: [e.id], trigger: 'manual', userId: req.user.id, waitFor: +(req.body || {}).wait_for || null });
  if (!r.id) return bad(res, { already_queued: 'כבר יש הודעה לאדם זה שממתינה לשליחה', nothing_open: 'ההוראה כבר לא פתוחה', no_phone: 'אין מספר טלפון לאדם זה' }[r.skipped] || 'לא נשלח: ' + r.skipped);
  sendNow();
  res.json({ ok: true, window: sendWindow() });
});
app.post('/api/events/:id/status', P('change_status'), (req, res) => {
  const e = db.prepare('SELECT * FROM return_events WHERE id = ?').get(+req.params.id);
  if (!e || !canSeeCase(req.user, e.case_id)) return bad(res, 'לא נמצא', 404);
  const st = req.body.status === 'open' ? 'open' : 'resolved';
  const note = String(req.body.note || '').trim();
  if (st === 'resolved' && !req.body.confirm_settled) return bad(res, 'יש לאשר שהתשלום עבור הוראה זו הוסדר');
  let caseClosed = false;
  db.transaction(() => {
    const ts = now();
    db.prepare('UPDATE return_events SET status = ?, resolved_at = ? WHERE id = ?').run(st, st === 'resolved' ? ts : null, e.id);
    logAction(e.case_id, req.user.id, 'status', `הוראת קבע ${e.charge_item ? '"' + e.charge_item + '" ' : ''}(₪${e.amount}) סומנה ${st === 'resolved' ? 'כהוסדרה' : 'כפתוחה'}${note ? '\n' + note : ''}`);
    const left = db.prepare("SELECT COUNT(*) n FROM return_events WHERE case_id = ? AND status = 'open'").get(e.case_id).n;
    const c = db.prepare('SELECT status FROM cases WHERE id = ?').get(e.case_id);
    if (!left && ['new', 'in_progress', 'waiting'].includes(c.status)) {
      db.prepare("UPDATE cases SET status='resolved', resolved_at=?, next_followup_date=NULL WHERE id=?").run(ts, e.case_id);
      logAction(e.case_id, req.user.id, 'status', 'כל הוראות הקבע בתיק הוסדרו – התיק נסגר אוטומטית', c.status, 'resolved');
      caseClosed = true;
    }
    if (st === 'open' && ['resolved', 'unresolvable'].includes(c.status)) {
      db.prepare("UPDATE cases SET status='in_progress', resolved_at=NULL WHERE id=?").run(e.case_id);
      logAction(e.case_id, req.user.id, 'status', 'התיק נפתח מחדש – הוראה סומנה כפתוחה', c.status, 'in_progress');
    }
  })();
  res.json({ ok: true, caseClosed });
});

app.post('/api/cases/:id/followup', P('change_status'), (req, res) => {
  const id = +req.params.id;
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  if (!c) return bad(res, 'התיק לא נמצא', 404);
  const d = (req.body || {}).followup_date || null;
  if (c.status === 'waiting' && !d) return bad(res, 'תיק ממתין חייב תאריך מעקב');
  db.prepare('UPDATE cases SET next_followup_date = ? WHERE id = ?').run(d, id);
  logAction(id, req.user.id, 'followup', d ? `נקבע תאריך מעקב: ${heDate(d)}` : 'תאריך המעקב הוסר', c.next_followup_date, d);
  res.json({ ok: true });
});

function assign(caseId, toUserId, byUserId, note) {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!c || c.assigned_user_id === toUserId) return false;
  db.prepare('UPDATE cases SET assigned_user_id = ? WHERE id = ?').run(toUserId, caseId);
  db.prepare('INSERT INTO assignments (case_id, from_user_id, to_user_id, by_user_id, note, created_at) VALUES (?,?,?,?,?,?)')
    .run(caseId, c.assigned_user_id, toUserId, byUserId, note || null, now());
  const from = userName(c.assigned_user_id), to = userName(toUserId);
  logAction(caseId, byUserId, 'assign', from ? `התיק הועבר מ${from} ל${to || 'ללא מטפל'}` : `התיק שויך ל${to}`, String(c.assigned_user_id || ''), String(toUserId || ''));
  if (toUserId && toUserId !== byUserId) {
    const ct = db.prepare('SELECT ct.full_name FROM cases c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?').get(caseId);
    db.prepare('INSERT INTO notifications (user_id, case_id, kind, message) VALUES (?,?,?,?)').run(toUserId, caseId, 'assigned', `שויך אליך תיק: ${ct.full_name || ''}`);
  }
  return true;
}

app.post('/api/cases/:id/assign', P('assign'), (req, res) => {
  const id = +req.params.id;
  const to = req.body.user_id ? +req.body.user_id : null;
  if (to && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(to)) return bad(res, 'העובד לא נמצא');
  db.transaction(() => assign(id, to, req.user.id, req.body.note))();
  res.json({ ok: true });
});

app.post('/api/cases/bulk-delete', P('delete'), (req, res) => {
  const ids = ((req.body || {}).case_ids || []).map(Number).filter(Boolean);
  const reason = String((req.body || {}).reason || '');
  let n = 0;
  db.transaction(() => {
    for (const id of ids) {
      const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
      if (!c) continue;
      const events = db.prepare('SELECT * FROM return_events WHERE case_id = ?').all(id);
      db.prepare('INSERT INTO deleted_records (kind, ref_id, snapshot_json, reason, deleted_by) VALUES (?,?,?,?,?)')
        .run('case', id, JSON.stringify({ case: c, events, actions: db.prepare('SELECT * FROM actions WHERE case_id = ?').all(id) }), reason, req.user.id);
      for (const e of events) db.prepare('INSERT OR IGNORE INTO suppressed_keys (dedup_key) VALUES (?)').run(e.dedup_key);
      purgeCase(id); n++;
    }
  })();
  res.json({ ok: true, deleted: n });
});

app.post('/api/cases/bulk-assign', P('assign'), (req, res) => {
  const { case_ids = [], user_id } = req.body || {};
  const to = user_id ? +user_id : null;
  let n = 0;
  db.transaction(() => { for (const id of case_ids) if (assign(+id, to, req.user.id, 'שיוך מרוכז')) n++; })();
  res.json({ ok: true, updated: n });
});

app.put('/api/contacts/:id', P('edit_contacts'), (req, res) => {
  const fields = ['full_name', 'phone1', 'phone2', 'phone3', 'email', 'address', 'city'];
  const ct = db.prepare('SELECT * FROM contacts WHERE id = ?').get(+req.params.id);
  if (!ct) return bad(res, 'לא נמצא', 404);
  { const sc = scope(req.user); if (!db.prepare(`SELECT 1 FROM cases c WHERE c.contact_id = ? AND ${sc.sql}`).get(ct.id, ...sc.params)) return bad(res, 'לא נמצא', 404); }
  const changes = fields.filter((f) => req.body[f] !== undefined && (req.body[f] || null) !== ct[f]);
  if (!changes.length) return res.json({ ok: true });
  db.prepare(`UPDATE contacts SET ${changes.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...changes.map((f) => req.body[f] || null), now(), ct.id);
  const kase = db.prepare('SELECT id FROM cases WHERE contact_id = ? ORDER BY id DESC LIMIT 1').get(ct.id);
  if (kase) logAction(kase.id, req.user.id, 'contact', `עודכנו פרטי קשר: ${changes.map((f) => `${f}: "${ct[f] || ''}" ← "${req.body[f] || ''}"`).join(', ')}`);
  res.json({ ok: true });
});

// שיחה אוטומטית – נכנסת לתור; מתבצעת רק אם חובר ספק
// במצב "הודעה מאוחדת": כל התיקים הפתוחים של האדם שהשולח רשאי לראות; אחרת – רק התיקים שנבחרו
function allowedOpenCases(user, contactId, selected) {
  if ((getSetting('send_mode') || 'unified') !== 'unified') return selected;
  const sc = scope(user);
  return db.prepare(`SELECT c.id FROM cases c WHERE c.contact_id = ? AND c.status IN ('new','in_progress','waiting') AND ${sc.sql}`).all(contactId, ...sc.params).map((r) => r.id);
}
function queueManualFor(user, caseIds, waitFor = null) {
  const res = { queued: 0, noPhone: 0, skipped: 0, closed: 0, unified: 0 };
  const rows = caseIds.map((id) => db.prepare('SELECT id, contact_id, status FROM cases WHERE id = ?').get(id)).filter((c) => c && canSeeCase(user, c.id));
  const open = rows.filter((r) => ['new', 'in_progress', 'waiting'].includes(r.status));
  res.closed = rows.length - open.length;
  const unified = (getSetting('send_mode') || 'unified') === 'unified';
  const groups = unified ? [...new Map(open.map((r) => [r.contact_id, null])).keys()].map((cid) => [cid, allowedOpenCases(user, cid, open.filter((x) => x.contact_id === cid).map((x) => x.id))])
    : open.map((r) => [r.contact_id, [r.id]]);
  for (const [cid, ids] of groups) {
    const r = MSG.queueMessage(cid, { caseIds: ids, trigger: 'manual', userId: user.id, waitFor });
    if (r.id) { res.queued++; if (r.count > 1) res.unified++; } else if (r.skipped === 'no_phone') res.noPhone++; else res.skipped++;
  }
  return res;
}

app.post('/api/cases/:id/auto-call', (req, res) => {
  const id = +req.params.id;
  const c = db.prepare('SELECT ct.* FROM cases c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?').get(id);
  if (!c) return bad(res, 'התיק לא נמצא', 404);
  if (!auth.can(req.user, 'send_voice')) return bad(res, 'אין לך הרשאה לשלוח הודעות קוליות', 403);
  const phone = req.body.phone || c.phone1 || c.phone2 || c.phone3;
  if (!phone) return bad(res, 'אין מספר טלפון לאדם זה');
  const cs = db.prepare('SELECT contact_id FROM cases WHERE id = ?').get(id);
  const r = MSG.queueMessage(cs.contact_id, { caseIds: allowedOpenCases(req.user, cs.contact_id, [id]), trigger: 'manual', userId: req.user.id, phone, waitFor: +req.body.wait_for || null });
  if (!r.id) return bad(res, { already_queued: 'כבר יש הודעה לאדם זה שממתינה לשליחה', nothing_open: 'אין הוראות פתוחות לאדם זה' }[r.skipped] || 'לא נשלח: ' + r.skipped);
  sendNow();
  res.json({ ok: true, phoneStatus: integ.phoneStatus(), window: sendWindow(), unified: r.count > 1, count: r.count });
});


// ---------- תיעוד שיחה מובנה: תוצאה אחת → המערכת קובעת את הצעד הבא ----------
const OUTCOMES = {
  no_answer: 'לא ענה', callback: 'ביקש לחזור אליו', promised: 'התחייב לשלם', updated_method: 'עדכן אמצעי תשלום',
  paid: 'שילם', cancel_request: 'מבקש לבטל את ההוראה', wrong_number: 'מספר שגוי',
};
function nextWorkday(iso, add = 1) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + add);
  while (d.getDay() === 5 || d.getDay() === 6) d.setDate(d.getDate() + 1); // דילוג על שישי-שבת
  return d.toISOString().slice(0, 10);
}
app.post('/api/cases/:id/outcome', P('change_status'), (req, res) => {
  const id = +req.params.id;
  const c = db.prepare(`${CASE_LIST_SQL} WHERE c.id = ?`).get(id);
  const { outcome, text = '', date, time, phone, confirm_settled } = req.body || {};
  if (!OUTCOMES[outcome]) return bad(res, 'יש לבחור תוצאת שיחה');
  const t = today();
  let followup = null, ftime = null, newStatus = c.status === 'new' ? 'in_progress' : c.status, extra = '';
  switch (outcome) {
    case 'no_answer': {
      const attempts = (c.attempts || 0) + 1;
      db.prepare('UPDATE cases SET attempts = ? WHERE id = ?').run(attempts, id);
      followup = nextWorkday(t);
      extra = `ניסיון ${attempts}. מעקב: ${heDate(followup)}`;
      if (attempts >= 3) extra += '\nאחרי 3 ניסיונות – מומלץ לשלוח הודעה קולית.';
      break;
    }
    case 'callback':
      if (!date) return bad(res, 'יש לבחור תאריך שבו ביקש שיחזרו אליו');
      followup = date; ftime = time || null; extra = `לחזור אליו ב-${heDate(date)}${time ? ' בשעה ' + time : ''}`;
      break;
    case 'promised':
      if (!date) return bad(res, 'יש לבחור את התאריך שבו התחייב לשלם');
      followup = nextWorkday(date); extra = `התחייב לשלם עד ${heDate(date)}. בדיקה ב-${heDate(followup)}`;
      if (followup > nextWorkday(t, 20)) newStatus = 'waiting';
      break;
    case 'updated_method':
      followup = date || nextWorkday(t, 30); newStatus = 'waiting';
      extra = `עדכן פרטי אמצעי תשלום. בדיקה אחרי החיוב הבא: ${heDate(followup)}`;
      break;
    case 'paid':
      if (!confirm_settled) return bad(res, 'כדי לסמן ששילם יש לאשר שהחוב הוסדר');
      newStatus = 'resolved'; extra = 'אושר שהחוב הוסדר';
      break;
    case 'cancel_request':
      followup = nextWorkday(t); extra = 'הועבר להחלטת המנהל';
      for (const a of db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all())
        db.prepare('INSERT INTO notifications (user_id, case_id, kind, message) VALUES (?,?,?,?)').run(a.id, id, 'cancel', `${c.full_name || ''} מבקש לבטל את הוראת הקבע – נדרשת החלטה`);
      break;
    case 'wrong_number': {
      const bad_ = [...new Set([...(c.bad_phones ? c.bad_phones.split(',') : []), phone || c.phone1].filter(Boolean))];
      db.prepare('UPDATE contacts SET bad_phones = ? WHERE id = ?').run(bad_.join(','), c.contact_id);
      followup = t; extra = `המספר ${phone || c.phone1 || ''} סומן כשגוי – לנסות טלפון אחר`;
      break;
    }
  }
  db.transaction(() => {
    const ts = now();
    db.prepare('INSERT INTO actions (case_id, user_id, type, text, outcome, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, req.user.id, outcome === 'no_answer' ? 'call_no_answer' : 'call', `${OUTCOMES[outcome]}. ${extra}${text.trim() ? '\n' + text.trim() : ''}`, outcome, ts);
    db.prepare(`UPDATE cases SET status = ?, next_followup_date = ?, followup_time = ?, last_action_at = ?, updated_at = ?, resolved_at = ? WHERE id = ?`)
      .run(newStatus, newStatus === 'resolved' ? null : followup, newStatus === 'resolved' ? null : ftime, ts, ts, newStatus === 'resolved' ? ts : null, id);
    if (newStatus !== c.status) db.prepare('INSERT INTO actions (case_id, user_id, type, text, old_value, new_value, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, req.user.id, 'status', `סטטוס: "${STATUSES[c.status]}" ← "${STATUSES[newStatus]}"`, c.status, newStatus, ts);
    if (!c.assigned_user_id) assign(id, req.user.id, req.user.id, 'שויך אוטומטית למי שתיעד את השיחה הראשונה');
    if (newStatus === 'resolved') db.prepare("UPDATE return_events SET status='resolved', resolved_at=? WHERE case_id = ? AND status='open'").run(now(), id);
  })();
  res.json({ ok: true, followup, status: newStatus });
});


// ---------- מחיקה (מנהל בלבד): שורת חיוב שגויה או תיק שלם ----------
// נשמר עותק במחיקות (deleted_records), והשורה לא תחזור בייבוא חוזר של אותו קובץ
function purgeCase(caseId) {
  for (const t of ['return_events', 'actions', 'assignments', 'voice_calls', 'call_queue', 'notifications']) db.prepare(`DELETE FROM ${t} WHERE case_id = ?`).run(caseId);
  db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);
}
app.delete('/api/events/:id', P('delete'), (req, res) => {
  const e = db.prepare('SELECT * FROM return_events WHERE id = ?').get(+req.params.id);
  if (!e) return bad(res, 'השורה לא נמצאה', 404);
  const reason = String((req.body || {}).reason || '').trim();
  let caseDeleted = false;
  db.transaction(() => {
    db.prepare('INSERT INTO deleted_records (kind, ref_id, snapshot_json, reason, deleted_by) VALUES (?,?,?,?,?)').run('event', e.id, JSON.stringify(e), reason, req.user.id);
    db.prepare('INSERT OR IGNORE INTO suppressed_keys (dedup_key) VALUES (?)').run(e.dedup_key);
    db.prepare('DELETE FROM return_events WHERE id = ?').run(e.id);
    const left = db.prepare('SELECT COUNT(*) n FROM return_events WHERE case_id = ?').get(e.case_id).n;
    if (!left) { purgeCase(e.case_id); caseDeleted = true; }
    else logAction(e.case_id, req.user.id, 'delete', `נמחקה שורת חיוב: ${e.charge_date ? heDate(e.charge_date) + ' · ' : ''}₪${e.amount}${e.charge_item ? ' · ' + e.charge_item : ''}${reason ? '\nסיבה: ' + reason : ''}`);
  })();
  res.json({ ok: true, caseDeleted });
});
app.delete('/api/cases/:id', P('delete'), (req, res) => {
  const id = +req.params.id;
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  if (!c) return bad(res, 'התיק לא נמצא', 404);
  const events = db.prepare('SELECT * FROM return_events WHERE case_id = ?').all(id);
  db.transaction(() => {
    db.prepare('INSERT INTO deleted_records (kind, ref_id, snapshot_json, reason, deleted_by) VALUES (?,?,?,?,?)')
      .run('case', id, JSON.stringify({ case: c, events, actions: db.prepare('SELECT * FROM actions WHERE case_id = ?').all(id) }), String((req.body || {}).reason || ''), req.user.id);
    for (const e of events) db.prepare('INSERT OR IGNORE INTO suppressed_keys (dedup_key) VALUES (?)').run(e.dedup_key);
    purgeCase(id);
  })();
  res.json({ ok: true });
});


// ---------- הוספה ידנית (בלי Excel) ----------
function addManualEvent(caseId, contactId, sourceId, e, userId) {
  const amount = Math.abs(parseFloat(String(e.amount || '0').replace(/[^\d.\-]/g, '')) || 0);
  db.prepare(`INSERT INTO return_events (contact_id, case_id, import_id, charge_date, amount, reason, reason_code, reference, raw_json, dedup_key, source_id, charge_item, payment_method, expiry)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(contactId, caseId, null, e.date || today(), amount, e.reason || null, null, e.reference || null,
    JSON.stringify({ 'נוסף ידנית': 'כן' }), 'manual-' + crypto.randomBytes(10).toString('hex'), sourceId || null, e.charge_item || null, e.payment_method || null, e.expiry || null);
  return amount;
}
app.post('/api/cases/manual', P('add_manual'), (req, res) => {
  const b = req.body || {};
  const name = String(b.full_name || '').trim();
  if (!name) return bad(res, 'יש להזין שם');
  const ev = b.event || {};
  let src = b.source_id ? db.prepare('SELECT * FROM sources WHERE id = ?').get(+b.source_id) : null;
  if (b.update_kind === 'expiry') {
    // עדכון פקיעת תוקף: סעיף + חודש/שנה. נרשם בסוג "חסרי אמצעי תשלום" (מעקב אמצעי תשלום)
    if (!String(ev.charge_item || '').trim()) return bad(res, 'יש להזין על איזה סעיף ההוראה');
    const m = String(ev.expiry_month || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return bad(res, 'יש לבחור חודש ושנה של פקיעת התוקף');
    ev.expiry = `${m[2]}/${m[1].slice(2)}`; ev.amount = ev.amount || 0;
    if (!src || src.kind !== 'payment_methods') src = db.prepare("SELECT * FROM sources WHERE kind = 'payment_methods' AND active = 1 ORDER BY id LIMIT 1").get() || src;
  } else if (src && src.kind === 'returns' && !(parseFloat(ev.amount) > 0)) return bad(res, 'יש להזין סכום');
  const extId = String(b.external_id || '').trim() || ('ידני-' + Date.now().toString().slice(-8));
  const ts = now();
  let caseId, created = false;
  db.transaction(() => {
    let ct = db.prepare('SELECT * FROM contacts WHERE external_id = ?').get(extId);
    const phones = [b.phone1, b.phone2].map((x) => String(x || '').trim() || null);
    if (!ct) {
      const id = db.prepare('INSERT INTO contacts (external_id, full_name, phone1, phone2, email, address, city) VALUES (?,?,?,?,?,?,?)')
        .run(extId, name, phones[0], phones[1], b.email || null, b.address || null, b.city || null).lastInsertRowid;
      ct = { id };
    } else {
      db.prepare('UPDATE contacts SET full_name = ?, phone1 = COALESCE(?, phone1), phone2 = COALESCE(?, phone2), address = COALESCE(?, address), city = COALESCE(?, city), updated_at = ? WHERE id = ?')
        .run(name, phones[0], phones[1], b.address || null, b.city || null, ts, ct.id);
    }
    let kase = db.prepare("SELECT * FROM cases WHERE contact_id = ? AND COALESCE(source_id,0) = ? AND status IN ('new','in_progress','waiting') ORDER BY id DESC LIMIT 1").get(ct.id, src ? src.id : 0);
    if (!kase) {
      const assignee = b.assignee_id ? +b.assignee_id : (src && src.default_assignee_id) || (req.user.role === 'admin' ? null : req.user.id);
      caseId = db.prepare("INSERT INTO cases (contact_id, status, created_at, updated_at, source_id, assigned_user_id) VALUES (?, 'new', ?, ?, ?, ?)").run(ct.id, ts, ts, src ? src.id : null, assignee).lastInsertRowid;
      if (assignee) db.prepare('INSERT INTO assignments (case_id, from_user_id, to_user_id, by_user_id, note, created_at) VALUES (?,?,?,?,?,?)').run(caseId, null, assignee, req.user.id, 'שיוך בהוספה ידנית', ts);
      created = true;
    } else caseId = kase.id;
    const amt = addManualEvent(caseId, ct.id, src ? src.id : null, ev, req.user.id);
    db.prepare('INSERT INTO actions (case_id, user_id, type, text, created_at) VALUES (?,?,?,?,?)').run(caseId, req.user.id, 'import',
      `${b.update_kind === 'expiry' ? `${created ? 'תיק נפתח ידנית' : 'נוסף ידנית'}: פקיעת תוקף ${ev.expiry}` : `${created ? 'תיק נפתח ידנית' : 'נוסף חיוב ידנית'}: ₪${amt}`}${ev.charge_item ? ' · ' + ev.charge_item : ''}${ev.payment_method ? ' · ' + ev.payment_method : ''}${ev.reason ? ' · ' + ev.reason : ''}`, ts);
  })();
  res.json({ ok: true, case_id: caseId, created });
});
app.post('/api/cases/:id/events', P('add_manual'), (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(+req.params.id);
  if (!c) return bad(res, 'לא נמצא', 404);
  const ev = req.body || {};
  if (!(parseFloat(ev.amount) >= 0)) return bad(res, 'סכום לא תקין');
  let amt;
  db.transaction(() => {
    amt = addManualEvent(c.id, c.contact_id, c.source_id, ev, req.user.id);
    logAction(c.id, req.user.id, 'import', `נוסף חיוב ידנית: ₪${amt}${ev.charge_item ? ' · ' + ev.charge_item : ''}${ev.payment_method ? ' · ' + ev.payment_method : ''}${ev.reason ? ' · ' + ev.reason : ''}`);
  })();
  res.json({ ok: true });
});


// ---------- כרטיס אדם: כל מה שחזר לאדם אחד, מכל סוגי הקבצים ----------
app.get('/api/people', P('people'), (req, res) => {
  const sc = scope(req.user);
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = db.prepare(`SELECT ct.id, ct.external_id, ct.full_name, ct.phone1, ct.city,
      COUNT(DISTINCT c.id) cases_n,
      SUM(CASE WHEN c.status IN ${OPEN_SQL} THEN 1 ELSE 0 END) open_n,
      (SELECT COALESCE(SUM(e.amount),0) FROM return_events e JOIN cases c2 ON c2.id = e.case_id WHERE c2.contact_id = ct.id AND c2.status IN ${OPEN_SQL}) open_amount,
      GROUP_CONCAT(DISTINCT s.name) sources,
      GROUP_CONCAT(DISTINCT u.full_name) workers,
      MAX(c.last_action_at) last_action,
      (SELECT COUNT(*) FROM voice_calls v JOIN cases c3 ON c3.id = v.case_id WHERE c3.contact_id = ct.id) voice_n
    FROM contacts ct JOIN cases c ON c.contact_id = ct.id LEFT JOIN sources s ON s.id = c.source_id LEFT JOIN users u ON u.id = c.assigned_user_id
    WHERE ${sc.sql} ${q ? 'AND (ct.full_name LIKE ? OR ct.external_id LIKE ? OR ct.phone1 LIKE ? OR ct.phone2 LIKE ?)' : ''}
    GROUP BY ct.id ORDER BY open_n DESC, cases_n DESC, ct.full_name LIMIT 500`).all(...sc.params, ...(q ? [like, like, like, like] : []));
  res.json(rows);
});
app.get('/api/people/:id', P('people'), (req, res) => {
  const sc = scope(req.user);
  const ct = db.prepare('SELECT * FROM contacts WHERE id = ?').get(+req.params.id);
  if (!ct) return bad(res, 'לא נמצא', 404);
  const cases = db.prepare(`${CASE_LIST_SQL} WHERE c.contact_id = ? AND ${sc.sql} ORDER BY c.id DESC`).all(ct.id, ...sc.params);
  if (!cases.length) return bad(res, 'אין לך הרשאה לאדם זה', 404);
  const ids = cases.map((c) => c.id);
  const ph = ids.map(() => '?').join(',');
  const events = db.prepare(`SELECT e.*, s.name source_name FROM return_events e LEFT JOIN sources s ON s.id = e.source_id WHERE e.case_id IN (${ph}) ORDER BY e.charge_date DESC, e.id DESC`).all(...ids);
  const actions = db.prepare(`SELECT a.*, u.full_name user_name, s.name source_name FROM actions a LEFT JOIN users u ON u.id = a.user_id JOIN cases c ON c.id = a.case_id LEFT JOIN sources s ON s.id = c.source_id
    WHERE a.case_id IN (${ph}) ORDER BY a.id DESC LIMIT 300`).all(...ids);
  const voice = db.prepare(`SELECT v.*, s.name source_name FROM voice_calls v JOIN cases c ON c.id = v.case_id LEFT JOIN sources s ON s.id = c.source_id WHERE v.case_id IN (${ph}) ORDER BY v.id DESC`).all(...ids);
  const openIds = cases.filter((c) => ['new', 'in_progress', 'waiting'].includes(c.status)).map((c) => c.id);
  let preview = null;
  if (openIds.length) {
    const m = MSG.buildMessage(ct.id, { caseIds: openIds });
    if (m && m.count) preview = { text: m.text, count: m.count, total: m.total,
      queued: !!db.prepare("SELECT 1 FROM voice_calls WHERE contact_id = ? AND status = 'queued'").get(ct.id) };
  }
  res.json({ contact: ct, cases, events, actions, voice, preview });
});
// הודעה קולית אחת לאדם – על כל ההוראות הפתוחות שלו (שהשולח רשאי לראות)
app.post('/api/people/:id/voice', P('send_voice'), (req, res) => {
  const sc = scope(req.user);
  const ids = db.prepare(`SELECT c.id FROM cases c WHERE c.contact_id = ? AND c.status IN ('new','in_progress','waiting') AND ${sc.sql}`).all(+req.params.id, ...sc.params).map((r) => r.id);
  if (!ids.length) return bad(res, 'אין לאדם זה הוראות פתוחות');
  const r = MSG.queueMessage(+req.params.id, { caseIds: ids, trigger: 'manual', userId: req.user.id, waitFor: +(req.body || {}).wait_for || null });
  if (!r.id) return bad(res, { already_queued: 'כבר יש הודעה לאדם זה שממתינה לשליחה', nothing_open: 'אין הוראות פתוחות לאדם זה', no_phone: 'אין מספר טלפון לאדם זה' }[r.skipped] || 'לא נשלח: ' + r.skipped);
  sendNow();
  res.json({ ok: true, count: r.count, window: sendWindow() });
});

// ---------- דוח מסודר להדפסה / PDF ----------
app.get('/api/report', P('export'), (req, res) => {
  const sc = scope(req.user);
  const onlyOpen = req.query.status !== 'all';
  const src = req.query.source ? +req.query.source : null;
  let where = `${sc.sql}`; const params = [...sc.params];
  if (onlyOpen) where += " AND c.status IN ('new','in_progress','waiting')";
  if (src) { where += ' AND c.source_id = ?'; params.push(src); }
  const cases = db.prepare(`${CASE_LIST_SQL} WHERE ${where} ORDER BY s.name, ct.full_name`).all(...params);
  const evStmt = db.prepare('SELECT charge_date, charge_item, amount, reason, status, expiry FROM return_events WHERE case_id = ? ORDER BY charge_date, id');
  for (const c of cases) c.events = evStmt.all(c.id);
  res.json({ generated_at: now(), org: getSetting('org_name') || '', onlyOpen, cases });
});

// ---------- סוגי קבצים ----------
app.get('/api/sources', (req, res) => {
  const sc = scope(req.user);
  const rows = db.prepare(`SELECT s.*, u.full_name assignee_name,
      (SELECT COUNT(*) FROM cases c WHERE c.source_id = s.id AND c.status IN ${OPEN_SQL} AND ${sc.sql}) open_cases,
      (SELECT COALESCE(SUM(e.amount),0) FROM cases c JOIN return_events e ON e.case_id = c.id WHERE c.source_id = s.id AND c.status IN ${OPEN_SQL} AND ${sc.sql}) open_amount,
      (SELECT GROUP_CONCAT(user_id) FROM user_sources us WHERE us.source_id = s.id) extra_users
    FROM sources s LEFT JOIN users u ON u.id = s.default_assignee_id ORDER BY s.active DESC, s.name`).all(...sc.params, ...sc.params);
  res.json(req.user.role === 'admin' ? rows : rows.filter((r) => r.open_cases > 0 || r.default_assignee_id === req.user.id || (r.extra_users || '').split(',').includes(String(req.user.id))));
});
function saveSource(id, b) {
  const fields = { name: (b.name || '').trim(), kind: b.kind === 'payment_methods' ? 'payment_methods' : 'returns', default_assignee_id: b.default_assignee_id ? +b.default_assignee_id : null,
    callback_phone: b.callback_phone || null, voice_message: b.voice_message || null, nedarim_target: b.nedarim_target || null, callback_days: Math.max(1, Math.min(30, +b.callback_days || 3)) };
  if (b.config && typeof b.config === 'object') {
    const c = {};
    for (const k of Object.keys(MSG.SOURCE_DEFAULTS)) if (k in b.config) c[k] = b.config[k];
    if ('allow_record' in c) c.allow_record = !!c.allow_record;
    if ('reminders_enabled' in c) c.reminders_enabled = !!c.reminders_enabled;
    for (const k of ['reminder_days', 'reminder_max']) if (k in c) c[k] = Math.max(1, Math.min(60, +c[k] || 1));
    if ('routing_rules' in c) c.routing_rules = (Array.isArray(c.routing_rules) ? c.routing_rules : []).map((r) => ({
      label: String(r.label || '').trim().slice(0, 60), phone: String(r.phone || '').replace(/[^\d]/g, '').slice(0, 12),
      days: String(r.days || '').split(',').filter((x) => /^[0-6]$/.test(x)).join(','), from: /^\d{2}:\d{2}$/.test(r.from) ? r.from : '00:00', to: /^\d{2}:\d{2}$/.test(r.to) ? r.to : '23:59',
    })).filter((r) => r.phone);
    if ('reminder_texts' in c) c.reminder_texts = (Array.isArray(c.reminder_texts) ? c.reminder_texts : String(c.reminder_texts).split('\n')).map((x) => String(x).trim()).filter(Boolean);
    for (const k of ['office_digit', 'main_digit']) if (k in c) c[k] = String(c[k] || '').replace(/\D/g, '').slice(0, 1);
    fields.config_json = JSON.stringify(c);
  }
  if (!fields.name) throw new Error('יש להזין שם לסוג הקובץ');
  if (id) db.prepare(`UPDATE sources SET ${Object.keys(fields).map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...Object.values(fields), id);
  else id = db.prepare(`INSERT INTO sources (${Object.keys(fields).join(',')}) VALUES (${Object.keys(fields).map(() => '?').join(',')})`).run(...Object.values(fields)).lastInsertRowid;
  if (Array.isArray(b.extra_user_ids)) {
    db.prepare('DELETE FROM user_sources WHERE source_id = ?').run(id);
    for (const u of b.extra_user_ids) db.prepare('INSERT OR IGNORE INTO user_sources (user_id, source_id) VALUES (?,?)').run(+u, id);
  }
  return id;
}
app.post('/api/sources', auth.requireAdmin, (req, res) => { try { res.json({ ok: true, id: db.transaction(() => saveSource(null, req.body || {}))() }); } catch (e) { bad(res, e.message); } });
app.put('/api/sources/:id', auth.requireAdmin, (req, res) => {
  const id = +req.params.id;
  const before = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  if (!before) return bad(res, 'לא נמצא', 404);
  try {
    db.transaction(() => {
      saveSource(id, req.body || {});
      // העברת התיקים הפתוחים לאחראי החדש אם ביקשו
      if (req.body.move_open_cases && req.body.default_assignee_id && +req.body.default_assignee_id !== before.default_assignee_id) {
        for (const c of db.prepare(`SELECT id FROM cases WHERE source_id = ? AND status IN ${OPEN_SQL}`).all(id)) assign(c.id, +req.body.default_assignee_id, req.user.id, 'החלפת אחראי לסוג הקובץ');
      }
    })();
    res.json({ ok: true });
  } catch (e) { bad(res, e.message); }
});
app.post('/api/sources/:id/active', auth.requireAdmin, (req, res) => { db.prepare('UPDATE sources SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, +req.params.id); res.json({ ok: true }); });

// ---------- דשבורדים ----------
app.get('/api/dashboard/me', (req, res) => {
  const t = today(), uid = req.user.id;
  const base = `${CASE_LIST_SQL} WHERE c.assigned_user_id = ? AND c.status IN ('new','in_progress')`;
  const todayL = db.prepare(`${base} AND c.next_followup_date = ? ORDER BY COALESCE(c.followup_time,'99'), c.id`).all(uid, t);
  const late = db.prepare(`${base} AND c.next_followup_date < ? ORDER BY c.next_followup_date`).all(uid, t);
  const fresh = db.prepare(`${base} AND c.status = 'new' AND c.next_followup_date IS NULL ORDER BY c.created_at`).all(uid);
  const lastAction = db.prepare(`SELECT case_id, text, outcome, created_at FROM actions WHERE id IN (SELECT MAX(id) FROM actions WHERE user_id IS NOT NULL AND type IN ('call','call_no_answer','note','payment_promise') GROUP BY case_id)`).all();
  const lastBy = Object.fromEntries(lastAction.map((a) => [a.case_id, a]));
  const attach = (l) => l.map((c) => ({ ...c, last_note: lastBy[c.id] ? lastBy[c.id].text : null }));
  const callsToday = db.prepare("SELECT COUNT(*) n FROM actions WHERE user_id = ? AND type IN ('call','call_no_answer') AND substr(created_at,1,10) = ?").get(uid, t).n;
  const month = t.slice(0, 7);
  const m = db.prepare(`SELECT COUNT(*) received,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) resolved,
      COALESCE(SUM(CASE WHEN status='resolved' THEN (SELECT SUM(amount) FROM return_events e WHERE e.case_id = c.id) END),0) resolved_amount
    FROM cases c WHERE c.assigned_user_id = ? AND substr(c.created_at,1,7) = ?`).get(uid, month);
  res.json({ today: attach(todayL), late: attach(late), fresh: attach(fresh), callsToday, month: m });
});
app.get('/api/dashboard/admin', P('admin_dashboard'), (req, res) => {
  const t = today(), month = t.slice(0, 7);
  const rows = db.prepare(`SELECT s.id, s.name, s.kind, u.full_name assignee,
      SUM(CASE WHEN c.status IN ${OPEN_SQL} THEN 1 ELSE 0 END) open_n,
      COALESCE(SUM(CASE WHEN c.status IN ${OPEN_SQL} THEN (SELECT SUM(amount) FROM return_events e WHERE e.case_id = c.id) END),0) open_amount,
      SUM(CASE WHEN c.status IN ('new','in_progress') AND c.next_followup_date < ? THEN 1 ELSE 0 END) late_n,
      SUM(CASE WHEN c.status IN ('new','in_progress') AND julianday('now','localtime') - julianday(COALESCE(c.last_action_at, c.created_at)) > 3 THEN 1 ELSE 0 END) idle_n,
      COUNT(c.id) total_n,
      SUM(CASE WHEN c.status = 'resolved' THEN 1 ELSE 0 END) resolved_n,
      COALESCE(SUM(CASE WHEN c.status = 'resolved' AND substr(c.resolved_at,1,7) = ? THEN (SELECT SUM(amount) FROM return_events e WHERE e.case_id = c.id) END),0) resolved_month
    FROM sources s LEFT JOIN users u ON u.id = s.default_assignee_id LEFT JOIN cases c ON c.source_id = s.id
    WHERE s.active = 1 GROUP BY s.id ORDER BY s.name`).all(t, month);
  const workers = db.prepare(`SELECT u.id, u.full_name,
      SUM(CASE WHEN c.status IN ${OPEN_SQL} THEN 1 ELSE 0 END) open_n,
      SUM(CASE WHEN c.status IN ('new','in_progress') AND c.next_followup_date < ? THEN 1 ELSE 0 END) late_n,
      (SELECT COUNT(*) FROM actions a WHERE a.user_id = u.id AND a.type IN ('call','call_no_answer') AND substr(a.created_at,1,10) = ?) calls_today
    FROM users u LEFT JOIN cases c ON c.assigned_user_id = u.id WHERE u.active = 1 GROUP BY u.id ORDER BY u.full_name`).all(t, t);
  res.json({ sources: rows, workers });
});

// ---------- הודעות קוליות ----------
const VOICE_SEL = `SELECT v.id, v.case_id, v.contact_id, v.phone, v.message_text, v.status, v.listen_status, v.listened_seconds, v.message_seconds, v.answered_at, v.digit_pressed, v.recording_url, v.local_file, v.transcript, v.transcript_status,
    v.trigger, v.reminder_no, v.event_ids, v.case_ids, v.handled, v.error, v.created_at, v.updated_at, v.created_by, u.full_name sent_by,
    ct.full_name, ct.external_id, s.name source_name, c.source_id, c.assigned_user_id
  FROM voice_calls v JOIN cases c ON c.id = v.case_id JOIN contacts ct ON ct.id = c.contact_id LEFT JOIN sources s ON s.id = c.source_id LEFT JOIN users u ON u.id = v.created_by`;
app.get('/api/voice', P('voice'), (req, res) => {
  // הודעה מאוחדת שייכת לכל התיקים שבה: עובד רואה אותה אם אחד מהתיקים בתחום שלו
  const full = req.user.role === 'admin' || auth.can(req.user, 'all_sources');
  const rows = db.prepare(`${VOICE_SEL} ORDER BY v.id DESC LIMIT 8000`).all().filter((r) => r.trigger !== 'login_code').filter((r) => {
    if (full) return true;
    let ids = []; try { ids = JSON.parse(r.case_ids || '[]'); } catch (_) { ids = []; }
    if (!ids.includes(r.case_id)) ids.push(r.case_id);
    const visible = ids.filter((id) => canSeeCase(req.user, id));
    if (!visible.length) return false;
    if (visible.length < ids.length) { r.message_text = 'הודעה מאוחדת – כוללת גם הוראות של מוסדות אחרים'; r.partial = true; if (!visible.includes(r.case_id)) { r.case_id = visible[0]; } }
    return true;
  }).slice(0, 5000);
  const hide = !auth.can(req.user, 'listen_recordings');
  res.json({ status: integ.phoneStatus(), window: sendWindow(), mode: getSetting('send_mode') || 'unified', calls: hide ? rows.map((r) => ({ ...r, transcript: null, recording_url: null, local_file: null })) : rows });
});
// כמה אנשים יקבלו הודעה מקובץ שיובא (אחרי איחוד לפי אדם)
function importContacts(importId, user) {
  const sc = scope(user);
  return db.prepare(`SELECT DISTINCT c.id, c.contact_id, ct.phone1, ct.phone2, ct.phone3 FROM return_events e JOIN cases c ON c.id = e.case_id JOIN contacts ct ON ct.id = c.contact_id
    WHERE e.import_id = ? AND e.status = 'open' AND c.status IN ('new','in_progress','waiting') AND ${sc.sql}`).all(importId, ...sc.params);
}
app.get('/api/voice/import/:id', P('send_voice'), (req, res) => {
  const rows = importContacts(+req.params.id, req.user);
  const people = new Map(); for (const r of rows) people.set(r.contact_id, r);
  const withPhone = [...people.values()].filter((r) => r.phone1 || r.phone2 || r.phone3);
  const multi = [...people.keys()].filter((cid) => MSG.openEvents(cid).length > 1).length;
  res.json({ total: people.size, withPhone: withPhone.length, noPhone: people.size - withPhone.length, multi, mode: getSetting('send_mode') || 'unified', phoneStatus: integ.phoneStatus() });
});
app.post('/api/voice/import/:id', P('send_voice'), (req, res) => {
  const r = queueManualFor(req.user, importContacts(+req.params.id, req.user).map((x) => x.id), +(req.body || {}).wait_for || null);
  if (r.queued) sendNow();
  res.json({ ok: true, ...r, phoneStatus: integ.phoneStatus(), window: sendWindow() });
});
app.post('/api/voice/cases', P('send_voice'), (req, res) => {
  const r = queueManualFor(req.user, ((req.body || {}).case_ids || []).map(Number).filter(Boolean), +(req.body || {}).wait_for || null);
  if (r.queued) sendNow();
  res.json({ ok: true, ...r, window: sendWindow() });
});
app.post('/api/voice/bulk', P('send_voice'), (req, res) => {
  const list = db.prepare(`SELECT c.id FROM cases c WHERE c.source_id = ? AND c.status = 'new' AND NOT EXISTS (SELECT 1 FROM voice_calls v WHERE v.case_id = c.id)`).all(+req.body.source_id);
  const r = queueManualFor(req.user, list.map((x) => x.id), +(req.body || {}).wait_for || null);
  if (r.queued) sendNow();
  res.json({ ok: true, ...r, phoneStatus: integ.phoneStatus(), window: sendWindow() });
});
// הודעות ממי שאין לו תיק – לפי המוסד שבחר בתפריט
function unknownScope(user) {
  if (user.role === 'admin' || auth.can(user, 'all_sources')) return { sql: '1=1', params: [] };
  return { sql: 'm.source_id IN (SELECT source_id FROM user_sources WHERE user_id = ? UNION SELECT id FROM sources WHERE default_assignee_id = ?)', params: [user.id, user.id] };
}
app.get('/api/voice/unknown', P('voice'), (req, res) => {
  const sc = unknownScope(req.user);
  const rows = db.prepare(`SELECT m.*, s.name source_name FROM unknown_messages m LEFT JOIN sources s ON s.id = m.source_id WHERE ${sc.sql} ORDER BY m.id DESC LIMIT 1000`).all(...sc.params);
  res.json(auth.can(req.user, 'listen_recordings') ? rows : rows.map((r) => ({ ...r, transcript: null })));
});
async function sendRecording(res, row) {
  if (row.local_file) {
    const f = path.join(yemot.REC_DIR, path.basename(row.local_file));
    if (fs.existsSync(f)) return res.type('audio/wav').sendFile(f);
  }
  if (!row.recording_url) return bad(res, 'ההקלטה עדיין לא זמינה', 404);
  const f = await yemot.downloadFile(row.recording_url);
  res.type(f.type).send(f.buf);
}
const canUnknown = (user, m) => { const sc = unknownScope(user); return !!db.prepare(`SELECT 1 FROM unknown_messages m WHERE m.id = ? AND ${sc.sql}`).get(m.id, ...sc.params); };
app.get('/api/voice/unknown/:id/recording', P('listen_recordings'), wrap(async (req, res) => {
  const m = db.prepare('SELECT * FROM unknown_messages WHERE id = ?').get(+req.params.id);
  if (!m || !canUnknown(req.user, m)) return bad(res, 'לא נמצא', 404);
  await sendRecording(res, m);
}));
app.post('/api/voice/unknown/:id/handled', P('voice'), (req, res) => {
  const m = db.prepare('SELECT * FROM unknown_messages WHERE id = ?').get(+req.params.id);
  if (!m || !canUnknown(req.user, m)) return bad(res, 'לא נמצא', 404);
  db.prepare('UPDATE unknown_messages SET handled = 1 WHERE id = ?').run(m.id); res.json({ ok: true });
});
app.post('/api/voice/:id/handled', P('voice'), (req, res) => {
  const v = db.prepare('SELECT * FROM voice_calls WHERE id = ?').get(+req.params.id);
  if (!canSeeCall(req.user, v)) return bad(res, 'לא נמצא', 404);
  db.prepare('UPDATE voice_calls SET handled = 1, updated_at = ? WHERE id = ?').run(now(), v.id);
  res.json({ ok: true });
});
app.delete('/api/voice/:id', P('send_voice'), (req, res) => {
  const v = db.prepare('SELECT * FROM voice_calls WHERE id = ?').get(+req.params.id);
  if (!v || !canSeeCase(req.user, v.case_id)) return bad(res, 'לא נמצא', 404);
  db.prepare("UPDATE voice_calls SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'").run(now(), v.id);
  res.json({ ok: true });
});
// תמלול חוזר (דורש שירות תמלול חיצוני)
app.post('/api/voice/:kind/:id/retranscribe', P('listen_recordings'), wrap(async (req, res) => {
  const table = req.params.kind === 'unknown' ? 'unknown_messages' : 'voice_calls';
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(+req.params.id);
  if (!row) return bad(res, 'לא נמצא', 404);
  if (table === 'voice_calls' ? !canSeeCall(req.user, row) : !canUnknown(req.user, row)) return bad(res, 'לא נמצא', 404);
  let buf;
  if (row.local_file && fs.existsSync(path.join(yemot.REC_DIR, path.basename(row.local_file)))) buf = fs.readFileSync(path.join(yemot.REC_DIR, path.basename(row.local_file)));
  else if (row.recording_url) buf = (await yemot.downloadFile(row.recording_url)).buf;
  else return bad(res, 'אין הקלטה לתמלול');
  // התמלול רץ ברקע (יכול לקחת דקה-שתיים); המסך מציג "מתמלל…" עד שמסתיים
  db.prepare(`UPDATE ${table} SET transcript_status = 'pending' WHERE id = ?`).run(row.id);
  if (!row.local_file) { const local = `${table}-${row.id}-${Date.now()}.wav`; fs.writeFileSync(path.join(yemot.REC_DIR, local), buf); db.prepare(`UPDATE ${table} SET local_file = ? WHERE id = ?`).run(local, row.id); }
  yemot.retranscribe(buf).then((text) => db.prepare(`UPDATE ${table} SET transcript = ?, transcript_status = ? WHERE id = ?`).run(text || null, text ? 'done' : 'failed', row.id))
    .catch((e) => { console.error('[stt]', e.message); db.prepare(`UPDATE ${table} SET transcript_status = 'failed' WHERE id = ?`).run(row.id); });
  res.json({ ok: true, pending: true });
}));
// תמלול כל ההקלטות הישנות שעדיין לא תומללו (ברקע, אחת אחרי השנייה)
app.post('/api/voice/transcribe-all', auth.requireAdmin, (req, res) => {
  const rows = [
    ...db.prepare("SELECT 'voice_calls' t, id, recording_url, local_file FROM voice_calls WHERE (transcript IS NULL OR transcript = '') AND (recording_url IS NOT NULL OR local_file IS NOT NULL)").all(),
    ...db.prepare("SELECT 'unknown_messages' t, id, recording_url, local_file FROM unknown_messages WHERE (transcript IS NULL OR transcript = '') AND (recording_url IS NOT NULL OR local_file IS NOT NULL)").all(),
  ];
  for (const r of rows) db.prepare(`UPDATE ${r.t} SET transcript_status = 'pending' WHERE id = ?`).run(r.id);
  (async () => {
    for (const r of rows) {
      try {
        let buf;
        const lf = r.local_file && path.join(yemot.REC_DIR, path.basename(r.local_file));
        if (lf && fs.existsSync(lf)) buf = fs.readFileSync(lf); else buf = (await yemot.downloadFile(r.recording_url)).buf;
        if (!r.local_file) { const local = `${r.t}-${r.id}-${Date.now()}.wav`; fs.writeFileSync(path.join(yemot.REC_DIR, local), buf); db.prepare(`UPDATE ${r.t} SET local_file = ? WHERE id = ?`).run(local, r.id); }
        const text = await yemot.retranscribe(buf);
        db.prepare(`UPDATE ${r.t} SET transcript = ?, transcript_status = ? WHERE id = ?`).run(text || null, text ? 'done' : 'failed', r.id);
      } catch (e) { console.error('[stt-all]', e.message); db.prepare(`UPDATE ${r.t} SET transcript_status = 'failed' WHERE id = ?`).run(r.id); }
    }
  })();
  res.json({ ok: true, count: rows.length });
});

// ---------- ימות המשיח ----------
app.post('/api/yemot/setup', auth.requireAdmin, wrap(async (req, res) => {
  try {
    const s = await yemot.testConnection();
    const site = `${req.protocol}://${req.get('host')}`;
    const inst = await yemot.installIvr(site);
    setSetting('yemot_verified', '1');
    res.json({ ok: true, session: { name: s.name, units: s.units }, ivr: inst });
  } catch (e) { setSetting('yemot_verified', '0'); bad(res, e.message); }
}));
// ---------- שיחות חימום: שיחה אחת מכל סוג הודעה לטלפון של המנהל ----------
function warmupCase() {
  let ct = db.prepare("SELECT id FROM contacts WHERE external_id = '__warmup__'").get();
  if (!ct) ct = { id: db.prepare("INSERT INTO contacts (external_id, full_name) VALUES ('__warmup__', 'שיחות חימום (מערכת)')").run().lastInsertRowid };
  let c = db.prepare('SELECT id FROM cases WHERE contact_id = ?').get(ct.id);
  if (!c) c = { id: db.prepare("INSERT INTO cases (contact_id, source_id, status) VALUES (?, (SELECT id FROM sources ORDER BY id LIMIT 1), 'resolved')").run(ct.id).lastInsertRowid };
  return { contactId: ct.id, caseId: c.id };
}
app.get('/api/yemot/warmup', auth.requireAdmin, (req, res) => {
  res.json({ items: MSG.warmupSamples(req.user.full_name).map((x) => x.label), phone: getSetting('yemot_test_phone') || '' });
});
app.post('/api/yemot/warmup', auth.requireAdmin, (req, res) => {
  const phone = String((req.body || {}).phone || '').replace(/\D/g, '');
  if (!/^0\d{8,9}$/.test(phone)) return bad(res, 'מספר טלפון לא תקין');
  setSetting('yemot_test_phone', phone);
  const w = warmupCase(); const ts = now();
  const list = MSG.warmupSamples(req.user.full_name);
  for (const m of list) {
    db.prepare(`INSERT INTO voice_calls (case_id, contact_id, phone, message_text, parts_json, event_ids, case_ids, menu_json, trigger, status, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?, '[]', '[]', ?, 'warmup', 'queued', ?, ?, ?)`).run(w.caseId, w.contactId, phone, `[${m.label}] ${m.text}`, JSON.stringify(m.parts), JSON.stringify(MSG.buildMenu(m.sourceIds)), req.user.id, ts, ts);
  }
  sendNow();
  res.json({ ok: true, count: list.length, window: sendWindow() });
});
// ---------- לפני שליחה: האם יש בהודעה חלקים חדשים שימות עוד לא הכינו? ----------
// selector: { contact_id } / { case_ids } / { event_id } / { import_id } / { source_id } – בדיוק מה שעומד להישלח
function messagesFor(user, b) {
  const sc = scope(user);
  let groups = [];
  if (b.contact_id) groups = [[+b.contact_id, null, null]];
  else if (b.event_id) { const e = db.prepare('SELECT * FROM return_events WHERE id = ?').get(+b.event_id); if (e) groups = [[e.contact_id, [e.case_id], [e.id]]]; }
  else {
    let ids = [];
    if (b.case_ids) ids = b.case_ids.map(Number);
    else if (b.import_id) ids = importContacts(+b.import_id, user).map((x) => x.id);
    else if (b.source_id) ids = db.prepare("SELECT c.id FROM cases c WHERE c.source_id = ? AND c.status = 'new'").all(+b.source_id).map((x) => x.id);
    const seen = new Map();
    for (const id of ids.slice(0, 2000)) { const c = db.prepare(`SELECT c.id, c.contact_id FROM cases c WHERE c.id = ? AND ${sc.sql}`).get(id, ...sc.params); if (c && !seen.has(c.contact_id)) seen.set(c.contact_id, [c.contact_id, null, null]); }
    groups = [...seen.values()];
  }
  return groups.slice(0, 300).map(([cid, caseIds, eventIds]) => MSG.buildMessage(cid, { caseIds, eventIds })).filter((m) => m && m.parts.length);
}
app.post('/api/voice/warm-check', P('send_voice'), (req, res) => {
  if (getSetting('warm_check') === '0') return res.json({ cold: 0 });
  const msgs = messagesFor(req.user, req.body || {});
  const cold = new Set();
  for (const m of msgs) for (const p of [...yemot.coldParts(m.parts), ...yemot.coldParts(['', ...MSG.buildMenu(m.sourceIds).map((o) => o.text)])]) cold.add(p);
  const me = db.prepare('SELECT phone FROM users WHERE id = ?').get(req.user.id) || {};
  res.json({ cold: cold.size, examples: [...cold].slice(0, 3), myPhone: me.phone || getSetting('yemot_test_phone') || '' });
});
app.post('/api/voice/warm-first', P('send_voice'), (req, res) => {
  const b = req.body || {};
  const phone = yemot.normPhone(b.phone);
  if (!/^0\d{8,9}$/.test(phone)) return bad(res, 'צריך את מספר הטלפון שלך לשיחת החימום');
  const msgs = messagesFor(req.user, b);
  if (!msgs.length) return bad(res, 'אין הודעה לחמם');
  // הודעה אחת שמכילה את החלקים החדשים, עם השם שלך במקום שם האדם
  const pick = msgs.find((m) => yemot.coldParts(m.parts).length) || msgs[0];
  const parts = [`שלום וברכה ${req.user.full_name}`, ...pick.parts.slice(1)];
  const w = warmupCase(); const ts = now();
  const id = db.prepare(`INSERT INTO voice_calls (case_id, contact_id, phone, message_text, parts_json, event_ids, case_ids, menu_json, trigger, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?, '[]', '[]', ?, 'warmup', 'queued', ?, ?, ?)`).run(w.caseId, w.contactId, phone, `[חימום לפני שליחה] ${parts.join(' ')}`, JSON.stringify(parts), JSON.stringify(MSG.buildMenu(pick.sourceIds)), req.user.id, ts, ts).lastInsertRowid;
  sendNow();
  res.json({ ok: true, warm_id: id, window: sendWindow() });
});
app.post('/api/yemot/test-call', auth.requireAdmin, wrap(async (req, res) => {
  const phone = String((req.body || {}).phone || '').trim();
  if (!/^0\d{8,9}$/.test(phone.replace(/\D/g, ''))) return bad(res, 'מספר טלפון לא תקין');
  { const cal = require('./src/calendar').status(); if (cal.blocked) return bad(res, `עכשיו ${cal.reason} – לא שולחים שיחות. אפשר לנסות שוב ${cal.untilLabel}.`); }
  setSetting('yemot_test_phone', phone); setSetting('yemot_test_until', String(Date.now() + 15 * 60e3));
  const msg = integ.outboundText('שלום, זוהי שיחת בדיקה ממערכת ההחזרות של הישיבה.');
  try { const r = await yemot.runPersonal({ [yemot.normPhone(phone)]: msg }); res.json({ ok: true, result: r }); } catch (e) { bad(res, e.message); }
}));
function canSeeCall(user, v) {
  if (!v) return false;
  let ids = []; try { ids = JSON.parse(v.case_ids || '[]'); } catch (_) { ids = []; }
  return [v.case_id, ...ids].some((id) => canSeeCase(user, id));
}
app.get('/api/voice/:id/recording', P('listen_recordings'), wrap(async (req, res) => {
  const v = db.prepare('SELECT * FROM voice_calls WHERE id = ?').get(+req.params.id);
  if (!canSeeCall(req.user, v)) return bad(res, 'לא נמצא', 404);
  await sendRecording(res, v);
}));

// ---------- התראות ומיילים ----------
app.get('/api/notifications', (req, res) => {
  const rows = db.prepare(`SELECT n.*, ct.full_name FROM notifications n LEFT JOIN cases c ON c.id = n.case_id LEFT JOIN contacts ct ON ct.id = c.contact_id
    WHERE n.user_id = ? OR (n.user_id IS NULL AND ? = 1) ORDER BY n.read_at IS NOT NULL, n.id DESC LIMIT 200`).all(req.user.id, req.user.role === 'admin' ? 1 : 0);
  res.json(rows);
});
app.post('/api/notifications/read', (req, res) => {
  const ids = (req.body.ids || []).map(Number);
  const stmt = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND (user_id = ? OR (user_id IS NULL AND ? = 1))');
  db.transaction(() => ids.forEach((id) => stmt.run(now(), id, req.user.id, req.user.role === 'admin' ? 1 : 0)))();
  res.json({ ok: true });
});

app.get('/api/automation', auth.requireAdmin, (req, res) => {
  res.json({
    email: integ.emailStatus(),
    phone: integ.phoneStatus(),
    outbox: db.prepare(`SELECT o.*, u.full_name to_name FROM email_outbox o LEFT JOIN users u ON u.id = o.to_user_id ORDER BY o.id DESC LIMIT 200`).all(),
    calls: db.prepare(`SELECT q.*, ct.full_name FROM call_queue q JOIN cases c ON c.id = q.case_id JOIN contacts ct ON ct.id = c.contact_id ORDER BY q.id DESC LIMIT 200`).all(),
    staleDays: +getSetting('stale_days'),
  });
});
app.post('/api/automation/run', auth.requireAdmin, wrap(async (req, res) => {
  const r = scheduler.runReminders();
  const mail = await integ.flushOutbox();
  const calls = await integ.processCallQueue();
  res.json({ ...r, mail, calls });
}));
// הכנת מייל סיכום לכל עובד עם רשימת התיקים הפתוחים שלו
app.post('/api/automation/digest', auth.requireAdmin, (req, res) => {
  const users = db.prepare('SELECT * FROM users WHERE active = 1').all();
  let n = 0;
  for (const u of users) {
    const cases = db.prepare(`${CASE_LIST_SQL} WHERE c.assigned_user_id = ? AND c.status IN ${OPEN_SQL} ORDER BY c.next_followup_date`).all(u.id);
    if (!cases.length) continue;
    const lines = cases.map((c) => `• ${c.full_name || ''} (${c.external_id}) – ₪${c.total_amount.toFixed(2)} – ${STATUSES[c.status]}${c.next_followup_date ? ' – מעקב ' + heDate(c.next_followup_date) : ''}`);
    integ.queueEmail({ userId: u.id, toEmail: u.email, subject: `התיקים הפתוחים שלך (${cases.length}) – החזרות הוראות קבע`,
      body: `שלום ${u.full_name},\n\nלהלן התיקים הפתוחים המשויכים אליך:\n\n${lines.join('\n')}\n\nבברכה,\n${getSetting('org_name')}` });
    n++;
  }
  res.json({ ok: true, prepared: n });
});
app.delete('/api/outbox/:id', auth.requireAdmin, (req, res) => {
  db.prepare("DELETE FROM email_outbox WHERE id = ? AND status <> 'sent'").run(+req.params.id);
  res.json({ ok: true });
});
app.delete('/api/calls/:id', auth.requireAdmin, (req, res) => {
  db.prepare("UPDATE call_queue SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(+req.params.id);
  res.json({ ok: true });
});

// ---------- עובדים ----------
app.get('/api/users', (req, res) => {
  const rows = db.prepare(`SELECT u.id, u.full_name, u.username, u.email, u.phone, u.role, u.active, u.created_at, (u.password_hash IS NOT NULL) can_login, u.permissions_json,
    (SELECT GROUP_CONCAT(source_id) FROM user_sources us WHERE us.user_id = u.id) source_ids,
    (SELECT COUNT(*) FROM cases c WHERE c.assigned_user_id = u.id AND c.status IN ${OPEN_SQL}) open_cases,
    (SELECT COALESCE(SUM(e.amount),0) FROM cases c JOIN return_events e ON e.case_id = c.id WHERE c.assigned_user_id = u.id AND c.status IN ${OPEN_SQL}) open_amount,
    (SELECT COUNT(*) FROM cases c WHERE c.assigned_user_id = u.id AND c.status = 'resolved') resolved_cases
    FROM users u ORDER BY u.active DESC, u.full_name`).all();
  const unassigned = db.prepare(`SELECT COUNT(*) n FROM cases WHERE assigned_user_id IS NULL AND status IN ${OPEN_SQL}`).get().n;
  const full = rows.map((r) => ({ ...r, perms: auth.perms(r), permissions_json: undefined }));
  res.json({ users: req.user.role === 'admin' ? full : full.map(({ username, email, phone, perms, source_ids, ...r }) => r), unassigned, permDefs: req.user.role === 'admin' ? auth.PERMS : undefined });
});

function saveUserScope(id, b) {
  if (b.perms && typeof b.perms === 'object') {
    const clean = Object.fromEntries(Object.keys(auth.PERMS).filter((k) => k in b.perms).map((k) => [k, !!b.perms[k]]));
    db.prepare('UPDATE users SET permissions_json = ? WHERE id = ?').run(JSON.stringify(clean), id);
  }
  if (Array.isArray(b.source_ids)) {
    db.prepare('DELETE FROM user_sources WHERE user_id = ?').run(id);
    for (const sid of b.source_ids) db.prepare('INSERT OR IGNORE INTO user_sources (user_id, source_id) VALUES (?,?)').run(id, +sid);
  }
}
app.post('/api/users', auth.requireAdmin, (req, res) => {
  const { full_name, username, email, phone, password, role = 'worker' } = req.body || {};
  if (!full_name || !full_name.trim()) return bad(res, 'יש להזין שם מלא');
  if (password && password.length < 8) return bad(res, 'סיסמה – לפחות 8 תווים');
  if (password && !username) return bad(res, 'כדי לאפשר כניסה יש להגדיר שם משתמש');
  if (username && db.prepare('SELECT 1 FROM users WHERE username = ?').get(username.trim().toLowerCase())) return bad(res, 'שם המשתמש כבר קיים');
  const id = db.prepare('INSERT INTO users (full_name, username, email, phone, password_hash, role) VALUES (?,?,?,?,?,?)')
    .run(full_name.trim(), username ? username.trim().toLowerCase() : null, email || null, phone || null, password ? auth.hashPassword(password) : null, role === 'admin' ? 'admin' : 'worker').lastInsertRowid;
  saveUserScope(id, req.body || {});
  res.json({ ok: true, id });
});

app.put('/api/users/:id', auth.requireAdmin, (req, res) => {
  const id = +req.params.id;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return bad(res, 'לא נמצא', 404);
  const { full_name, username, email, phone, password, role, active } = req.body || {};
  if (username && username.trim().toLowerCase() !== u.username && db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(username.trim().toLowerCase(), id)) return bad(res, 'שם המשתמש כבר קיים');
  if (password && password.length < 8) return bad(res, 'סיסמה – לפחות 8 תווים');
  if (id === req.user.id && (role === 'worker' || active === false || active === 0)) return bad(res, 'לא ניתן להסיר הרשאת מנהל או להשבית את עצמך');
  db.prepare('UPDATE users SET full_name=?, username=?, email=?, phone=?, role=?, active=? WHERE id=?').run(
    (full_name || u.full_name).trim(), username !== undefined ? (username ? username.trim().toLowerCase() : null) : u.username,
    email !== undefined ? email || null : u.email, phone !== undefined ? phone || null : u.phone,
    role ? (role === 'admin' ? 'admin' : 'worker') : u.role, active !== undefined ? (active ? 1 : 0) : u.active, id);
  if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), id);
  if (active === false || active === 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  saveUserScope(id, req.body || {});
  res.json({ ok: true });
});

// הסרת עובד: השבתה (ההיסטוריה נשמרת) + העברת התיקים הפתוחים שלו
app.post('/api/users/:id/remove', auth.requireAdmin, (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id) return bad(res, 'לא ניתן להסיר את עצמך');
  const to = req.body.transfer_to ? +req.body.transfer_to : null;
  const open = db.prepare(`SELECT id FROM cases WHERE assigned_user_id = ? AND status IN ${OPEN_SQL}`).all(id);
  db.transaction(() => {
    for (const c of open) assign(c.id, to, req.user.id, `העובד ${userName(id)} הוסר מהמערכת`);
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  })();
  res.json({ ok: true, transferred: open.length });
});

app.post('/api/users/:id/transfer', auth.requireAdmin, (req, res) => {
  const from = +req.params.id;
  const to = req.body.transfer_to ? +req.body.transfer_to : null;
  const open = db.prepare(`SELECT id FROM cases WHERE assigned_user_id = ? AND status IN ${OPEN_SQL}`).all(from);
  db.transaction(() => { for (const c of open) assign(c.id, to, req.user.id, 'העברה מרוכזת בין עובדים'); })();
  res.json({ ok: true, transferred: open.length });
});

app.get('/api/assignments', (req, res) => {
  res.json(db.prepare(`SELECT a.*, f.full_name from_name, t.full_name to_name, b.full_name by_name, ct.full_name contact_name, ct.external_id
    FROM assignments a LEFT JOIN users f ON f.id = a.from_user_id LEFT JOIN users t ON t.id = a.to_user_id LEFT JOIN users b ON b.id = a.by_user_id
    JOIN cases c ON c.id = a.case_id JOIN contacts ct ON ct.id = c.contact_id ORDER BY a.id DESC LIMIT 300`).all());
});

// ---------- ייבוא ----------
const pendingUploads = new Map(); // token -> {buffer, filename, at}
setInterval(() => { for (const [k, v] of pendingUploads) if (Date.now() - v.at > 30 * 60e3) pendingUploads.delete(k); }, 5 * 60e3).unref();

app.post('/api/import/analyze', P('import'), express.raw({ type: '*/*', limit: '30mb' }), wrap(async (req, res) => {
  const filename = decodeURIComponent(req.headers['x-filename'] || 'upload.xlsx');
  if (!req.body || !req.body.length) return bad(res, 'לא התקבל קובץ');
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(+req.headers['x-source-id'] || 0);
  if (!src) return bad(res, 'יש לבחור סוג קובץ לפני ההעלאה');
  let saved = null; try { saved = src.mapping_json ? JSON.parse(src.mapping_json) : null; } catch (_) { /* */ }
  const result = await importer.analyze(req.body, filename, saved);
  const token = crypto.randomBytes(16).toString('hex');
  pendingUploads.set(token, { buffer: Buffer.from(req.body), filename, at: Date.now(), sourceId: src.id });
  const fileHash = crypto.createHash('sha256').update(req.body).digest('hex');
  const prev = db.prepare('SELECT id, created_at, rows_imported FROM imports WHERE file_hash = ? ORDER BY id DESC LIMIT 1').get(fileHash);
  res.json({ token, filename, previousImport: prev || null, ...result });
}));

app.post('/api/import/commit', P('import'), wrap(async (req, res) => {
  const { token, sheet, mapping, period_label } = req.body || {};
  const up = pendingUploads.get(token);
  if (!up) return bad(res, 'פג תוקף ההעלאה – יש להעלות את הקובץ שוב');
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(up.sourceId);
  const result = await importer.runImport({ buffer: up.buffer, filename: up.filename, sheetName: sheet, mapping: mapping || {}, periodLabel: period_label, userId: req.user.id, source: src });
  pendingUploads.delete(token);
  // הודעה לאחראי על התיקים החדשים
  if (src && src.default_assignee_id && result.cases_created) {
    const txt = `נכנסו ${result.cases_created} תיקים חדשים ב"${src.name}"${src.kind === 'returns' ? ` בסך ₪${result.total_amount.toLocaleString('he-IL')}` : ''}`;
    db.prepare('INSERT INTO notifications (user_id, kind, message) VALUES (?,?,?)').run(src.default_assignee_id, 'import', txt);
    const u = db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(src.default_assignee_id);
    if (u && u.email) integ.queueEmail({ userId: src.default_assignee_id, toEmail: u.email, subject: txt, body: `שלום ${u.full_name},

${txt}.
הם מחכים לך במסך "היום שלי".

בברכה,
${getSetting('org_name')}` });
  }
  res.json(result);
}));

app.get('/api/imports', (req, res) => {
  res.json(db.prepare('SELECT i.*, u.full_name uploaded_by_name, s.name source_name FROM imports i LEFT JOIN users u ON u.id = i.uploaded_by LEFT JOIN sources s ON s.id = i.source_id ORDER BY i.id DESC').all());
});

// ---------- הגדרות ----------
const TEXT_KEYS = Object.keys(MSG.DEFAULTS);
const SETTING_KEYS = [...TEXT_KEYS, 'send_mode', 'voice_days', 'voice_hour_start', 'voice_hour_end', 'monthly_enabled', 'monthly_day', 'expiry_enabled', 'expiry_days',
  'office_phone', 'show_hebrew_dates', 'accent_color', 'admin_home', 'session_days', 'daily_call_limit', 'retry_unanswered_hours', 'retry_unanswered_max', 'min_days_between_auto', 'warm_check', 'callback_same_minutes', 'google_client_id', 'shabbat_stop_minutes', 'shabbat_resume', 'block_chol_hamoed', 'block_tisha_bav', 'tts_rate', 'tts_voice', 'google_tts_key', 'google_tts_voice', 'transcription_mode', 'stt_openai_key', 'stt_openai_model', 'tab_icons', 'yemot_system', 'yemot_password', 'yemot_template_id', 'yemot_ivr_path', 'yemot_caller_id', 'nedarim_target', 'email_provider', 'brevo_api_key', 'email_from_name', 'new_contact_days', 'escalate_days', 'morning_hour', 'nudge_hour', 'urgent_hours', 'org_name', 'stale_days', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from', 'phone_provider', 'phone_api_url', 'phone_api_key', 'phone_caller_id', 'phone_message'];
app.get('/api/settings', auth.requireAdmin, (req, res) => {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(k);
  out.smtp_pass = out.smtp_pass ? '********' : '';
  out.phone_api_key = out.phone_api_key ? '********' : '';
  out.brevo_api_key = out.brevo_api_key ? '********' : '';
  out.yemot_password = out.yemot_password ? '********' : '';
  out.stt_openai_key = out.stt_openai_key ? '********' : '';
  out.google_tts_key = out.google_tts_key ? '********' : '';
  for (const k of TEXT_KEYS) if (!out[k]) out[k] = MSG.DEFAULTS[k];
  out.send_mode = out.send_mode || 'unified'; out.voice_days = out.voice_days || '0,1,2,3,4'; out.voice_hour_start = out.voice_hour_start || '9'; out.voice_hour_end = out.voice_hour_end || '20';
  out.monthly_day = out.monthly_day || '1'; out.expiry_days = out.expiry_days || '30,7'; out.tts_rate = out.tts_rate || '0'; out.transcription_mode = !out.transcription_mode || out.transcription_mode === 'yemot' ? 'local' : out.transcription_mode;
  out.has_favicon = !!getSetting('favicon_data');
  out.shabbat_stop_minutes = out.shabbat_stop_minutes || '120'; out.shabbat_resume = out.shabbat_resume || 'next_morning';
  out.block_chol_hamoed = out.block_chol_hamoed || '1'; out.block_tisha_bav = out.block_tisha_bav || '1';
  res.json({ calendar: { next: require('./src/calendar').nextBlock(), now: require('./src/calendar').status() }, settings: out, email: integ.emailStatus(), phone: integ.phoneStatus(), stt: { yemot: out.transcription_mode === 'yemot_live', retry: true } });
});
app.put('/api/settings', auth.requireAdmin, (req, res) => {
  const body = req.body || {};
  const smtpChanged = ['email_provider', 'brevo_api_key', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure'].some((k) => body[k] !== undefined && body[k] !== '********' && body[k] !== getSetting(k));
  for (const k of SETTING_KEYS) {
    if (body[k] === undefined) continue;
    if ((k === 'smtp_pass' || k === 'phone_api_key' || k === 'brevo_api_key' || k === 'yemot_password' || k === 'stt_openai_key' || k === 'google_tts_key') && body[k] === '********') continue;
    if (k.startsWith('yemot_') && body[k] !== getSetting(k)) { setSetting('yemot_verified', '0'); yemot.resetToken(); }
    setSetting(k, body[k]);
  }
  if (smtpChanged) setSetting('email_enabled', '0'); // שינוי הגדרות מחייב בדיקה מחדש
  if (body.tts_rate !== undefined || body.tts_voice !== undefined) yemot.syncIvrIfChanged();
  res.json({ ok: true });
});
// השמעת דוגמה של הקול המוכן (בלי שיחה ובלי יחידות) – לבדיקה שהמפתח של גוגל עובד
app.post('/api/tts/preview', auth.requireAdmin, wrap(async (req, res) => {
  const text = String((req.body || {}).text || 'שלום וברכה ישראל ישראלי. לידיעתך, הוראת הקבע שלך לא כובדה, והתשלום על סך מאה שקלים עבור תורה הקדושה לא הושלם. להשארת הודעה הקישו 1.').slice(0, 600);
  try { const { buf } = await require('./src/tts').synth(text); res.setHeader('Content-Type', 'audio/wav'); res.end(buf); } catch (e) { bad(res, e.message); }
}));
app.post('/api/settings/test-email', auth.requireAdmin, wrap(async (req, res) => {
  const to = (req.body || {}).to || req.user.email;
  if (!to) return bad(res, 'יש להזין כתובת לבדיקה');
  try { await integ.testEmail(to); res.json({ ok: true }); } catch (e) { setSetting('email_enabled', '0'); bad(res, 'החיבור נכשל: ' + e.message); }
}));
// סמל המערכת (favicon)
app.post('/api/settings/favicon', auth.requireAdmin, express.json({ limit: '1mb' }), (req, res) => {
  const d = String((req.body || {}).data_url || '');
  if (!d) { setSetting('favicon_data', ''); return res.json({ ok: true }); }
  if (!/^data:image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif);base64,/.test(d)) return bad(res, 'יש להעלות קובץ תמונה (PNG / ICO / SVG / JPG)');
  if (d.length > 400000) return bad(res, 'הקובץ גדול מדי (עד כ-300KB)');
  setSetting('favicon_data', d); res.json({ ok: true });
});

// ---------- מסך בקרה ואוטומציות ----------
app.get('/api/control', P('control'), (req, res) => {
  const { source = '', worker = '', from = '', to = '', status = '', q = '' } = req.query;
  const sc = scope(req.user);
  const w = [sc.sql], p = [...sc.params];
  if (source) { w.push('c.source_id = ?'); p.push(+source); }
  if (worker) { w.push('c.assigned_user_id = ?'); p.push(+worker); }
  if (status) { w.push('c.status = ?'); p.push(status); }
  if (q) { w.push('(ct.full_name LIKE ? OR ct.external_id LIKE ? OR ct.phone1 LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const where = w.join(' AND ');
  const dateCond = (col) => `${from ? ` AND substr(${col},1,10) >= '${from.replace(/[^\d-]/g, '')}'` : ''}${to ? ` AND substr(${col},1,10) <= '${to.replace(/[^\d-]/g, '')}'` : ''}`;
  const base = `FROM cases c JOIN contacts ct ON ct.id = c.contact_id`;
  const one = (sql, ...extra) => db.prepare(sql).get(...p, ...extra);
  const returned = one(`SELECT COUNT(*) n, COALESCE(SUM(e.amount),0) amt ${base} JOIN return_events e ON e.case_id = c.id WHERE ${where}${dateCond('e.created_at')}`);
  const multiPeople = db.prepare(`SELECT ct.id, ct.full_name, ct.phone1, COUNT(e.id) n, SUM(e.amount) amt ${base} JOIN return_events e ON e.case_id = c.id
    WHERE ${where} AND e.status='open' AND c.status IN ${OPEN_SQL} GROUP BY ct.id HAVING n > 1 ORDER BY n DESC LIMIT 500`).all(...p);
  const unpaid = one(`SELECT COUNT(DISTINCT ct.id) n ${base} JOIN return_events e ON e.case_id = c.id WHERE ${where} AND e.status='open' AND c.status IN ${OPEN_SQL}`);
  const msgs = (trig) => db.prepare(`SELECT v.id, v.created_at, v.status, v.trigger, v.reminder_no, v.digit_pressed, ct.full_name, ct.phone1, c.id case_id, u.full_name sent_by
    FROM voice_calls v JOIN cases c ON c.id = v.case_id JOIN contacts ct ON ct.id = c.contact_id LEFT JOIN users u ON u.id = v.created_by
    WHERE ${where} AND v.trigger IN (${trig}) ${dateCond('v.created_at')} ORDER BY v.id DESC LIMIT 500`).all(...p);
  const manual = msgs("'manual'");
  const auto = msgs("'auto_reminder','monthly_no_method','expiry'");
  const due = automations.dueReminders().filter((d) => canSeeCase(req.user, d.case_id) && (!source || d.source_id === +source))
    .map((d) => ({ ...d, ...db.prepare('SELECT ct.full_name, ct.phone1 FROM contacts ct WHERE ct.id = ?').get(d.contact_id) }));
  const noMethod = automations.noMethodPeople().filter((x) => canSeeCase(req.user, x.case_id) && (!source || x.source_id === +source));
  const expiring = automations.expiringList(+(req.query.expiry_window || 60)).filter((x) => canSeeCase(req.user, x.case_id) && (!source || x.source_id === +source));
  const recs = db.prepare(`SELECT v.id, v.created_at, v.transcript_status, v.transcript, v.handled, ct.full_name, ct.phone1, c.id case_id FROM voice_calls v JOIN cases c ON c.id = v.case_id JOIN contacts ct ON ct.id = c.contact_id
    WHERE ${where} AND (v.recording_url IS NOT NULL OR v.local_file IS NOT NULL OR v.transcript IS NOT NULL) ${dateCond('v.created_at')} ORDER BY v.id DESC`).all(...p);
  const usc = unknownScope(req.user);
  const unk = db.prepare(`SELECT m.* FROM unknown_messages m WHERE ${usc.sql} ${source ? 'AND m.source_id = ' + (+source) : ''} ${dateCond('m.created_at')}`).all(...usc.params);
  const pendingHandling = recs.filter((r) => !r.handled).length + unk.filter((m) => !m.handled).length;
  res.json({
    metrics: {
      returned: returned.n, returned_amount: returned.amt, multi_people: multiPeople.length, unpaid_people: unpaid.n,
      manual_msgs: manual.length, auto_msgs: auto.length, due_reminders: due.length, no_method: noMethod.length, expiring: expiring.length,
      recordings: recs.length + unk.length, transcribed: recs.filter((r) => r.transcript_status === 'done').length + unk.filter((m) => m.transcript_status === 'done').length,
      transcribe_failed: recs.filter((r) => r.transcript_status === 'failed').length + unk.filter((m) => m.transcript_status === 'failed').length,
      pending_handling: pendingHandling,
    },
    lists: { multiPeople, manual, auto, due, noMethod, expiring, recordings: recs.slice(0, 300), unknown: unk.slice(0, 300) },
    automation: { monthly_enabled: getSetting('monthly_enabled') === '1', expiry_enabled: getSetting('expiry_enabled') === '1', send_mode: getSetting('send_mode') || 'unified', window: sendWindow() },
  });
});
app.post('/api/automations/run', auth.requireAdmin, wrap(async (req, res) => {
  const kind = (req.body || {}).kind;
  let r;
  if (kind === 'reminders') r = automations.runReminders();
  else if (kind === 'monthly') r = automations.runMonthly(true);
  else if (kind === 'expiry') r = automations.runExpiry(true);
  else r = automations.runAll();
  sendNow();
  res.json({ ok: true, result: r, window: sendWindow() });
}));

app.post('/api/settings/disable-email', auth.requireAdmin, (req, res) => { setSetting('email_enabled', '0'); res.json({ ok: true }); });

// ---------- ייצוא וגיבוי ----------
app.get('/api/export.xlsx', P('export'), wrap(async (req, res) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = getSetting('org_name');
  const addSheet = (name, cols, rows) => {
    const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map(([header, key, width]) => ({ header, key, width: width || 16 }));
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  };
  const cases = db.prepare(`${CASE_LIST_SQL} ORDER BY c.id`).all().map((c) => ({ ...c, status: STATUSES[c.status] }));
  addSheet('תיקים', [['מס תיק', 'id', 8], ['מזהה איש קשר', 'external_id'], ['שם מלא', 'full_name', 24], ['טלפון', 'phone1'], ['טלפון 2', 'phone2'], ['סכום כולל', 'total_amount', 12],
    ['מס חיובים', 'events_count', 10], ['סוג קובץ', 'source_name', 18], ['סעיף חיוב', 'charge_items', 22], ['סיבות החזרה', 'reasons', 30], ['סטטוס', 'status', 16], ['מטפל', 'assignee', 18], ['פעולה אחרונה', 'last_action_at', 18], ['מעקב הבא', 'next_followup_date', 14], ['נפתח', 'created_at', 18]], cases);
  addSheet('חיובים שחזרו', [['מס תיק', 'case_id', 8], ['מזהה איש קשר', 'external_id'], ['שם', 'full_name', 22], ['תאריך חיוב', 'charge_date'], ['סכום', 'amount', 10], ['סיבה', 'reason', 28],
    ['קוד', 'reason_code', 8], ['סעיף חיוב', 'charge_item', 20], ['אמצעי תשלום', 'payment_method', 16], ['מצב אמצעי תשלום', 'method_status', 16], ['תוקף', 'expiry', 10], ['אסמכתא', 'reference'], ['בנק', 'bank', 8], ['סניף', 'branch', 8], ['חשבון', 'account'], ['קובץ מקור', 'filename', 24]],
  db.prepare('SELECT e.*, ct.external_id, ct.full_name, i.filename FROM return_events e JOIN contacts ct ON ct.id = e.contact_id LEFT JOIN imports i ON i.id = e.import_id ORDER BY e.case_id, e.id').all());
  addSheet('היסטוריית פעולות', [['מס תיק', 'case_id', 8], ['מזהה איש קשר', 'external_id'], ['שם', 'full_name', 22], ['תאריך', 'created_at', 18], ['עובד', 'user_name', 18], ['סוג', 'type', 12], ['תיאור', 'text', 60]],
    db.prepare('SELECT a.*, u.full_name user_name, ct.external_id, ct.full_name FROM actions a LEFT JOIN users u ON u.id = a.user_id JOIN cases c ON c.id = a.case_id JOIN contacts ct ON ct.id = c.contact_id ORDER BY a.case_id, a.id').all());
  addSheet('אנשי קשר', [['מזהה', 'external_id'], ['שם', 'full_name', 24], ['טלפון 1', 'phone1'], ['טלפון 2', 'phone2'], ['טלפון 3', 'phone3'], ['דוא"ל', 'email', 24], ['כתובת', 'address', 28], ['עיר', 'city']],
    db.prepare('SELECT * FROM contacts ORDER BY id').all());
  addSheet('היסטוריית שיוכים', [['מס תיק', 'case_id', 8], ['תאריך', 'created_at', 18], ['ממטפל', 'from_name', 18], ['למטפל', 'to_name', 18], ['בוצע ע"י', 'by_name', 18], ['הערה', 'note', 30]],
    db.prepare('SELECT a.*, f.full_name from_name, t.full_name to_name, b.full_name by_name FROM assignments a LEFT JOIN users f ON f.id=a.from_user_id LEFT JOIN users t ON t.id=a.to_user_id LEFT JOIN users b ON b.id=a.by_user_id ORDER BY a.id').all());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('החזרות-הוראות-קבע-' + today() + '.xlsx')}`);
  await wb.xlsx.write(res);
  res.end();
}));

app.get('/api/backup', auth.requireAdmin, wrap(async (req, res) => {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `returns-${today()}-${Date.now()}.db`);
  await db.backup(file);
  res.download(file, path.basename(file));
}));

// ---------- שגיאות ----------
app.use('/api', (req, res) => bad(res, 'לא נמצא', 404));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'שגיאת שרת' });
});

// גיבוי יומי אוטומטי לתיקייה data/backups (שומר 30 אחרונים)
async function dailyBackup() {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `auto-${today()}.db`);
    if (!fs.existsSync(f)) await db.backup(f);
    const autos = fs.readdirSync(dir).filter((x) => x.startsWith('auto-')).sort();
    autos.slice(0, Math.max(0, autos.length - 30)).forEach((x) => fs.unlinkSync(path.join(dir, x)));
  } catch (e) { console.error('[backup]', e); }
}

// יצירת מנהל ראשון מתוך משתני סביבה (כדי שאיש לא יקדים ויתפוס את הגדרת המנהל)
// הגדרות ימות המשיח ממשתני סביבה (מוגדרים בשרת) – נכתבות להגדרות בעליית השרת
function bootstrapYemot() {
  const map = { YEMOT_SYSTEM: 'yemot_system', YEMOT_PASSWORD: 'yemot_password', YEMOT_TEMPLATE_ID: 'yemot_template_id', YEMOT_IVR_PATH: 'yemot_ivr_path', YEMOT_IVR_SECRET: 'yemot_ivr_secret', NEDARIM_TARGET: 'nedarim_target',
    YEMOT_TEST_PHONE: 'yemot_test_phone', OFFICE_PHONE: 'office_phone', BREVO_API_KEY: 'brevo_api_key', EMAIL_FROM: 'smtp_from', EMAIL_PROVIDER: 'email_provider' };
  let any = false;
  for (const [env, key] of Object.entries(map)) if (process.env[env] && getSetting(key) !== process.env[env]) { setSetting(key, process.env[env]); any = true; }
  if (any && process.env.YEMOT_VERIFIED === '1') setSetting('yemot_verified', '1');
  if (process.env.YEMOT_TEST_UNTIL) setSetting('yemot_test_until', process.env.YEMOT_TEST_UNTIL);
  if (process.env.EMAIL_VERIFIED === '1' && getSetting('brevo_api_key')) setSetting('email_enabled', '1');
}

// שחזור גישה: אם הוגדר ADMIN_RESET_PHONE – הטלפון נרשם אצל המנהל הראשון, וכך אפשר להיכנס עם קוד בשיחה קולית
function bootstrapAdminPhone() {
  const ph = String(process.env.ADMIN_RESET_PHONE || '').replace(/\D/g, '');
  if (!/^0\d{8,9}$/.test(ph)) return;
  const a = db.prepare("SELECT id, username FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get();
  if (a) { db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(ph, a.id); console.log('[recovery] admin phone set for user id', a.id); }
}
function bootstrapAdmin() {
  const u = (process.env.ADMIN_USERNAME || '').trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
  if (!u || pw.length < 8) return;
  if (db.prepare("SELECT 1 FROM users WHERE role='admin' AND password_hash IS NOT NULL").get()) return;
  db.prepare("INSERT INTO users (full_name, username, email, password_hash, role) VALUES (?,?,?,?, 'admin')")
    .run(process.env.ADMIN_NAME || 'מנהל המערכת', u, process.env.ADMIN_EMAIL || null, auth.hashPassword(pw));
  console.log('נוצר משתמש מנהל:', u);
}

// כיבוי מסודר כשהשרת מוחלף בגרסה חדשה (מונע הודעות "קרסה" מ-Railway)
function shutdown() {
  try { db.close(); } catch (_) { /* */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) {
  bootstrapAdmin();
  bootstrapAdminPhone();
  bootstrapYemot();
  app.listen(PORT, () => {
    console.log(`מערכת ההחזרות פועלת: http://localhost:${PORT}  (DB: ${DB_PATH})`);
    scheduler.start();
    setTimeout(() => yemot.syncIvrIfChanged(), 5000);
    dailyBackup();
    setInterval(dailyBackup, 6 * 3600e3);
  });
}
module.exports = app;
