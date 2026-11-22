// כניסה מאובטחת: סיסמאות מוצפנות ב-scrypt, עוגיית סשן HttpOnly, הרשאות לפי תפקיד
const crypto = require('crypto');
const { db } = require('./db');

const SESSION_DAYS = 14;
const COOKIE = 'yr_session';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function createSession(res, userId, secure, via = 'password') {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, via) VALUES (?, ?, ?, ?)').run(token, userId, exp.toISOString(), via);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
function destroySession(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function loadUser(req, _res, next) {
  const t = parseCookies(req)[COOKIE];
  if (t) {
    const row = db.prepare(`SELECT u.id, u.full_name, u.username, u.email, u.role, u.active, u.permissions_json, s.expires_at, s.via session_via, s.created_at session_created FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(t);
    if (row && row.active && new Date(row.expires_at) > new Date()) req.user = row;
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'נדרשת כניסה למערכת' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'נדרשת כניסה למערכת' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'פעולה זו מותרת למנהל בלבד' });
  next();
}

// הגנה בסיסית מפני ניחוש סיסמאות
const attempts = new Map();
function loginRateLimit(key) {
  const nowMs = Date.now();
  const a = (attempts.get(key) || []).filter((t) => nowMs - t < 15 * 60e3);
  attempts.set(key, a);
  return a.length >= 10;
}
function recordFailedLogin(key) { (attempts.get(key) || attempts.set(key, []).get(key)).push(Date.now()); }

// ---------- הרשאות מפורטות לכל עובד ----------
// מנהל (role=admin) מקבל הכל. לעובד – ברירת מחדל סבירה, ומנהל יכול לשנות כל הרשאה בנפרד.
const PERMS = {
  all_sources: { label: 'רואה את כל המוסדות (לא רק המוסדות שלו)', def: false },
  people: { label: 'מסך אנשי קשר', def: true },
  voice: { label: 'מסך הודעות קוליות', def: true },
  listen_recordings: { label: 'האזנה להקלטות וקריאת תמלולים', def: true },
  send_voice: { label: 'שליחת הודעות קוליות', def: false },
  assign: { label: 'שיוך והעברת תיקים', def: true },
  change_status: { label: 'שינוי סטטוס ותיעוד שיחות', def: true },
  add_manual: { label: 'הוספת תיק / חיוב ידנית', def: true },
  edit_contacts: { label: 'עריכת פרטי אנשים', def: true },
  export: { label: 'ייצוא ל-Excel', def: false },
  import: { label: 'ייבוא קבצים', def: false },
  delete: { label: 'מחיקת שורות ותיקים', def: false },
  admin_dashboard: { label: 'דשבורד מנהל', def: false },
  control: { label: 'מסך בקרה', def: false },
  workers: { label: 'מסך עובדים', def: true },
};
function perms(user) {
  if (!user) return {};
  if (user.role === 'admin') return Object.fromEntries(Object.keys(PERMS).map((k) => [k, true]));
  let custom = {};
  try { custom = user.permissions_json ? JSON.parse(user.permissions_json) : {}; } catch (_) { custom = {}; }
  return Object.fromEntries(Object.entries(PERMS).map(([k, v]) => [k, custom[k] != null ? !!custom[k] : v.def]));
}
const can = (user, key) => !!perms(user)[key];
function requirePerm(key) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'נדרשת כניסה למערכת' });
    if (!can(req.user, key)) return res.status(403).json({ error: `אין לך הרשאה לפעולה זו (${PERMS[key].label})` });
    next();
  };
}

module.exports = { PERMS, perms, can, requirePerm, hashPassword, verifyPassword, createSession, destroySession, loadUser, requireAuth, requireAdmin, loginRateLimit, recordFailedLogin };
