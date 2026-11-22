// חיבור ל"ימות המשיח": הוצאת שיחות (קמפיין) + שלוחת API שמנהלת את התפריט מול השרת שלנו.
// התהליך: הקמפיין מתקשר → כשעונים, ימות פונה לכתובת /api/yemot/ivr באתר → אנחנו מחזירים הודעה מותאמת ותפריט 1/2/3.
const crypto = require('crypto');
const { db, getSetting, setSetting, now, today, heDate } = require('./db');

const BASE = process.env.YEMOT_API_BASE || 'https://www.call2all.co.il/ym/api/';
let cachedToken = null;

function configured() { return !!(getSetting('yemot_system') && getSetting('yemot_password')); }
function ivrPath() { return (getSetting('yemot_ivr_path') || '9').replace(/^\/+|\/+$/g, ''); }
function ivrSecret() {
  let s = getSetting('yemot_ivr_secret');
  if (!s) { s = crypto.randomBytes(16).toString('hex'); setSetting('yemot_ivr_secret', s); }
  return s;
}

async function call(method, params = {}, retry = true) {
  if (!cachedToken) cachedToken = `${getSetting('yemot_system')}:${getSetting('yemot_password')}`;
  const body = new URLSearchParams({ token: cachedToken, ...params });
  const r = await fetch(BASE + method, { method: 'POST', body });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  if (data.responseStatus && data.responseStatus !== 'OK') {
    if (retry && /token|session/i.test(data.message || '')) {
      const l = await fetch(BASE + 'Login?' + new URLSearchParams({ username: getSetting('yemot_system'), password: getSetting('yemot_password') }));
      const lj = await l.json().catch(() => ({}));
      if (lj.token) { cachedToken = lj.token; return call(method, params, false); }
    }
    throw new Error(`ימות המשיח: ${data.message || data.responseStatus}`);
  }
  return data;
}
function resetToken() { cachedToken = null; }

async function testConnection() {
  resetToken();
  const s = await call('GetSession');
  return { ok: true, name: s.name || s.organization || '', units: s.units != null ? s.units : null, raw: s };
}

// התקנת השלוחה: קובץ ext.ini מסוג api שמפנה לאתר
// מהירות רגילה כברירת מחדל (המשתמש ביקש לא מהיר מדי). איפוס חד-פעמי של הערך הקודם 3
if (getSetting('tts_rate_reset_v1') !== '1') { setSetting('tts_rate', '0'); setSetting('tts_rate_reset_v1', '1'); }
const ttsRate = () => { const n = parseInt(getSetting('tts_rate') ?? '0', 10); return Number.isFinite(n) ? Math.max(-10, Math.min(10, n)) : 0; };
const ttsVoice = () => (['Jacob', 'Elik_2100'].includes(getSetting('tts_voice')) ? getSetting('tts_voice') : '');
// כתובת האתר לשלוחה: מה שנשמר בהתקנה האחרונה, או הכתובת הציבורית של Railway
const siteUrlGuess = () => getSetting('site_url') || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
// מעדכן את הגדרות השלוחה בימות אם השתנו (מהירות/קול/גרסה) – בלי שיחות ובלי יחידות
async function syncIvrIfChanged() {
  if (!configured() || getSetting('yemot_verified') !== '1') return;
  const site = siteUrlGuess(); if (!site) return;
  const sig = `v2|${ttsRate()}|${ttsVoice()}|${site}`;
  if (getSetting('ivr_ini_sig') === sig) return;
  try { await installIvr(site); setSetting('ivr_ini_sig', sig); console.log('[yemot] ext.ini updated', sig); } catch (e) { console.error('[yemot] ext.ini update failed', e.message); }
}
async function installIvr(siteUrl) {
  setSetting('site_url', siteUrl.replace(/\/$/, ''));
  const path = ivrPath();
  const ini = [
    'type=api',
    `api_link=${siteUrl.replace(/\/$/, '')}/api/yemot/ivr`,
    `api_add_0=key=${ivrSecret()}`,
    'api_hangup_send=yes',
    'api_say_tts=no',
    'api_save_file=yes',
    // מהירות ההקראה (בין -10 ל-10, 0 = רגיל) וקול המקריא – ניתנים לשינוי בהגדרות
    `rate=${ttsRate()}`,
    ...(ttsVoice() ? [`voice=${ttsVoice()}`] : []),
  ].join('\n');
  await call('UploadTextFile', { what: `ivr2:/${path}/ext.ini`, contents: ini });
  return { path, ini: ini.replace(/key=\w+/, 'key=••••') };
}

// שליחת קמפיין לרשימת טלפונים
async function runCampaign(phones) {
  { const cal = require('./calendar').status(); if (cal.blocked) throw new Error(`עכשיו ${cal.reason} – לא מחייגים (שמירת שבת וחג)`); }
  const templateId = getSetting('yemot_template_id');
  if (!templateId) throw new Error('חסר מספר תבנית קמפיין (בהגדרות)');
  const params = { templateId, phones: phones.join(':') };
  if (getSetting('yemot_caller_id')) params.callerId = getSetting('yemot_caller_id');
  return call('RunCampaign', params);
}

// קמפיין הודעות אישיות: לכל מספר הקראה משלו (ttsMode=1)
async function runPersonal(map) {
  { const cal = require('./calendar').status(); if (cal.blocked) throw new Error(`עכשיו ${cal.reason} – לא מחייגים (שמירת שבת וחג)`); }
  const params = { ttsMode: '1', phones: JSON.stringify(map) };
  if (getSetting('yemot_template_id')) params.templateId = getSetting('yemot_template_id');
  if (getSetting('yemot_caller_id')) params.callerId = getSetting('yemot_caller_id');
  return call('RunCampaign', params);
}

// ---- שיחה יוצאת שנכנסת ישר לשלוחת התפריט שלנו (CallExtensionBridging) ----
// כשעונים, השיחה נכנסת לשלוחה 9 → השרת שלנו מקריא את הפרטים האישיים ומיד את התפריט 1/2.
async function bridgeCalls(phones) {
  { const cal = require('./calendar').status(); if (cal.blocked) throw new Error(`עכשיו ${cal.reason} – לא מחייגים (שמירת שבת וחג)`); }
  const params = { phones: phones.join(':'), ivrPath: `ivr2:/${ivrPath()}`, callsTimeOut: '30' };
  if (getSetting('yemot_caller_id')) params.callerId = getSetting('yemot_caller_id');
  return call('CallExtensionBridging', params);
}

// ---- (שיטה קודמת) שליחה אישית דרך תבניות קמפיין ----
// ימות המשיח מקריאים את הטקסט שבתבנית, ולכן לפני כל שיחה כותבים לתבנית את הטקסט האישי ומחייגים.
// כדי לשלוח כמה במקביל משתמשים בכמה תבניות ("ערוצים"), כל ערוץ שולח שיחה אחת בכל רגע.
const LANES = 3;
async function lanePool() {
  let ids = (getSetting('yemot_template_pool') || '').split(',').filter(Boolean);
  while (ids.length < LANES) {
    const r = await call('CreateTemplate', { description: `החזרות הוראות קבע – ערוץ ${ids.length + 1}` });
    ids.push(String(r.templateId));
    setSetting('yemot_template_pool', ids.join(','));
  }
  return ids;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sendOne(templateId, phone, text) {
  await call('UploadTextFile', { what: `tpl:${templateId}:tts`, contents: text });
  const params = { templateId, phones: phone };
  if (getSetting('yemot_caller_id')) params.callerId = getSetting('yemot_caller_id');
  const r = await call('RunCampaign', params);
  // ממתינים שהשיחה תסתיים לפני שמשנים את הטקסט בתבנית לשיחה הבאה
  const start = Date.now();
  let st = null;
  while (Date.now() - start < 150000) {
    await sleep(4000);
    try { st = (await call('GetCampaignStatus', { campaignId: r.campaignId })).campaign; } catch (_) { st = null; }
    if (st && st.campaignStatus === 'FINISHED') break;
  }
  return { campaignId: r.campaignId, status: st };
}
async function sendPersonal(items, onResult) {
  const ids = await lanePool();
  const queue = items.slice();
  await Promise.all(ids.map(async (tid) => {
    while (queue.length) {
      const it = queue.shift();
      try { onResult(it, await sendOne(tid, it.phone, it.text), null); } catch (e) { onResult(it, null, e); }
    }
  }));
}

// הורדת הקלטה (מושמעת במערכת דרך השרת שלנו)
async function downloadFile(path) {
  if (!cachedToken) cachedToken = `${getSetting('yemot_system')}:${getSetting('yemot_password')}`;
  const r = await fetch(BASE + 'DownloadFile?' + new URLSearchParams({ token: cachedToken, path }));
  if (!r.ok) throw new Error('ההקלטה לא נמצאה');
  const ct = r.headers.get('content-type') || '';
  return { type: /\.wav$/i.test(path) || !ct || ct.includes('octet') ? 'audio/wav' : ct, buf: Buffer.from(await r.arrayBuffer()) };
}

const normPhone = (p) => String(p || '').replace(/\D/g, '').replace(/^972/, '0');
// טקסט להקראה: מסירים תווים שמשבשים את פקודות ימות
const tts = (s) => 't-' + String(s || '').replace(/["'״׳]/g, '').replace(/[=&.,\-:]/g, ' ').replace(/\s+/g, ' ').trim();
// כל קטע נשלח בנפרד – קטעים קבועים נשמרים אצל ימות ומתחילים מיד בפעם הבאה
const ttsList = (...parts) => parts.filter(Boolean).map(tts).join('.');
const M = () => require('./messaging');
const readVar = (name, digits, parts) => `read=${ttsList(...parts)}=${name},no,1,1,7,No,yes,no,,${digits.join('.')},2,,,,no`;

// משפט אישי (לתאימות לאחור – תצוגה ותיעוד)
function personalLine(caseId) {
  const c = db.prepare('SELECT contact_id FROM cases WHERE id = ?').get(caseId);
  const m = c && M().buildMessage(c.contact_id, { caseIds: [caseId] });
  return m ? m.text : '';
}

// ---- שמירת הקלטה מקומית + תמלול ----
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');
const REC_DIR = path.join(DATA_DIR, 'recordings');
fs.mkdirSync(REC_DIR, { recursive: true });
// מצב תמלול: אם הוגדר מפתח תמלול – מקליטים את כל ההודעה ומתמללים את הקובץ המלא אחרי השיחה (מדויק ולא נקטע).
// בלי מפתח – זיהוי דיבור של ימות המשיח בזמן השיחה (מוגבל, עלול לתמלל רק חלק).
// 'local' (ברירת מחדל): הקלטה מלאה + תמלול חינמי בתוך המערכת. 'yemot_live': זיהוי דיבור של ימות בזמן השיחה (עולה יחידות). 'off': רק הקלטה.
const sttMode = () => { const m = getSetting('transcription_mode') || 'local'; if (m === 'off') return 'off'; return m === 'yemot_live' ? 'yemot' : 'file'; };
const sttOn = () => sttMode() === 'yemot';
// הורדת ההקלטה המלאה מימות, שמירה אצלנו ותמלול של כל ההודעה
async function transcribeRecording(table, id, ivrFile, attempt = 1) {
  try {
    const dl = await downloadFile(ivrFile);
    const local = `${table}-${id}-${Date.now()}.wav`;
    fs.writeFileSync(path.join(REC_DIR, local), dl.buf);
    db.prepare(`UPDATE ${table} SET local_file = ? WHERE id = ?`).run(local, id);
    const text = await retranscribe(path.join(REC_DIR, local));
    db.prepare(`UPDATE ${table} SET transcript = ?, transcript_status = ? WHERE id = ?`).run(text || null, text ? 'done' : 'failed', id);
    if (text && table === 'voice_calls') {
      const v = db.prepare('SELECT case_ids, case_id FROM voice_calls WHERE id = ?').get(id);
      let ids = []; try { ids = JSON.parse(v.case_ids || '[]'); } catch (_) { ids = [v.case_id]; }
      for (const cid of ids.filter(Boolean)) db.prepare("INSERT INTO actions (case_id, type, text, created_at) VALUES (?, 'auto_call', ?, ?)").run(cid, `תמלול ההודעה: "${text.slice(0, 500)}"`, now());
    }
  } catch (e) {
    if (attempt < 4) return setTimeout(() => transcribeRecording(table, id, ivrFile, attempt + 1), 6000 * attempt);
    console.error('[yemot] transcription failed', e.message);
    db.prepare(`UPDATE ${table} SET transcript_status = 'failed' WHERE id = ? AND transcript IS NULL`).run(id);
  }
}
// במצב זיהוי דיבור, ימות שומרים את הקובץ זמנית ב-/Trash/ApiVoice. מורידים אותו מיד ושומרים אצלנו לצמיתות.
async function fetchApiVoiceFile(phone, table, id, attempt = 1) {
  try {
    const r = await call('GetIVR2Dir', { path: '/Trash/ApiVoice', filesLimit: '15', orderBy: 'date', orderDir: 'desc' });
    const files = (r.files || []).filter((f) => String(f.name || '').includes(`Phone-${phone}`));
    if (!files.length) throw new Error('הקובץ עדיין לא נמצא');
    const f = files[0];
    const dl = await downloadFile(`ivr2:/Trash/ApiVoice/${f.name}`);
    const local = `${table}-${id}-${Date.now()}.wav`;
    fs.writeFileSync(path.join(REC_DIR, local), dl.buf);
    db.prepare(`UPDATE ${table} SET local_file = ? WHERE id = ?`).run(local, id);
  } catch (e) {
    if (attempt < 4) setTimeout(() => fetchApiVoiceFile(phone, table, id, attempt + 1), 5000 * attempt);
    else console.error('[yemot] recording fetch failed', e.message);
  }
}
// הקלטות בזיהוי דיבור שעדיין לא נשמרו אצלנו (למשל אם השרת הופעל מחדש) – ניסיון נוסף מדי פעם, עד יממה אחורה
function sweepMissingFiles() {
  if (!sttOn()) return;
  for (const t of ['voice_calls', 'unknown_messages']) {
    const rows = db.prepare(`SELECT id, phone FROM ${t} WHERE local_file IS NULL AND transcript_status IN ('done','failed') AND julianday('now','localtime') - julianday(${t === 'voice_calls' ? 'updated_at' : 'created_at'}) < 1 LIMIT 20`).all();
    for (const r of rows) fetchApiVoiceFile(normPhone(r.phone), t, r.id, 4);
  }
}
// תמלול חוזר (או של הקלטה ישנה) – רק אם חובר שירות תמלול חיצוני
async function retranscribe(localPathOrBuf) {
  const key = getSetting('stt_openai_key');
  if (!key) {
    // תמלול חינמי בתוך המערכת
    let file = localPathOrBuf;
    if (Buffer.isBuffer(localPathOrBuf)) { file = path.join(REC_DIR, `tmp-${Date.now()}.wav`); fs.writeFileSync(file, localPathOrBuf); }
    try { return String(await require('./stt').transcribeFile(file)).trim(); } finally { if (file !== localPathOrBuf) fs.rmSync(file, { force: true }); }
  }
  const buf = Buffer.isBuffer(localPathOrBuf) ? localPathOrBuf : fs.readFileSync(localPathOrBuf);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'rec.wav');
  form.append('model', getSetting('stt_openai_model') || 'whisper-1');
  form.append('language', 'he');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('שירות התמלול החזיר שגיאה: ' + ((j.error && j.error.message) || r.status));
  return String(j.text || '').trim();
}
function recordCommand(callId) {
  const prompt = M().setting('ivr_record_prompt');
  if (sttOn()) return `read=${ttsList(...M().toParts(prompt))}=msg,no,voice,he,no,,record,5,180`;
  return `read=${ttsList(...M().toParts(prompt))}=rec,no,record,/${ivrPath()}/rec,${callId},no,yes,no,1,180`;
}
const savedReply = () => `id_list_message=${ttsList(...M().toParts(M().setting('ivr_record_saved')))}&go_to_folder=hangup`;
const menuPrompt = (opts) => opts.map((o) => o.text);
const notifyUsers = (userIds, caseId, msg) => { for (const u of [...new Set(userIds.filter(Boolean))]) db.prepare('INSERT INTO notifications (user_id, case_id, kind, message) VALUES (?,?,?,?)').run(u, caseId, 'voice', msg); };
const admins = () => db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all().map((u) => u.id);
const sourceWorkers = (sid) => {
  if (!sid) return [];
  const s = db.prepare('SELECT default_assignee_id FROM sources WHERE id = ?').get(sid);
  return [s && s.default_assignee_id, ...db.prepare('SELECT user_id FROM user_sources WHERE source_id = ?').all(sid).map((r) => r.user_id)];
};

// אורך משוער של ההקראה (שניות): קצב הקראה של ימות בעברית ~13 תווים לשנייה + הפסקה קצרה בין משפטים
const estimateSeconds = (parts) => Math.round(parts.join(' ').length / (13 * (1 + ttsRate() / 20)) + parts.length * 0.4);
const LISTEN_LABEL = { full: 'שמע את כל ההודעה', partial: 'שמע חלק מההודעה', early: 'ניתק בתחילת ההודעה' };
function finishListen(v, ts, pressed) {
  if (!v.answered_at) return null;
  const secs = Math.max(0, Math.round((new Date(ts.replace(' ', 'T')) - new Date(String(v.answered_at).replace(' ', 'T'))) / 1000));
  const est = v.message_seconds || 0;
  let st;
  if (pressed || (est && secs >= est * 0.9)) st = 'full';
  else if (secs < Math.max(4, est * 0.25)) st = 'early';
  else st = 'partial';
  db.prepare('UPDATE voice_calls SET listened_seconds = ?, listen_status = ? WHERE id = ?').run(secs, st, v.id);
  // אם הקשיב יותר מכמה שניות – ימות כבר הכינו את כל החלקים של ההודעה והתפריט
  try { const parts = JSON.parse(v.parts_json || '[]'); const menu = (JSON.parse(v.menu_json || '[]') || []).map((o) => o.text); markWarm(pressed || secs > 4 ? [...parts, ...menu] : parts.slice(0, 1)); } catch (_) { /* */ }
  return { secs, st, pct: est ? Math.min(100, Math.round((secs / est) * 100)) : null };
}

// העלאת קובץ שמע לשלוחה (ההקלטה המוכנה של ההודעה)
async function uploadAudio(name, buf, retry = true) {
  if (!cachedToken) cachedToken = `${getSetting('yemot_system')}:${getSetting('yemot_password')}`;
  const form = new FormData();
  form.append('token', cachedToken);
  form.append('path', `ivr2:/${ivrPath()}/${name}.wav`);
  form.append('convertAudio', '1');
  form.append('autoNumbering', 'false');
  form.append('file', new Blob([buf], { type: 'audio/wav' }), `${name}.wav`);
  const r = await fetch(BASE + 'UploadFile', { method: 'POST', body: form });
  const data = await r.json().catch(() => ({}));
  if (data.responseStatus && data.responseStatus !== 'OK') {
    if (retry && /token|session/i.test(data.message || '')) { resetToken(); await call('GetSession').catch(() => {}); return uploadAudio(name, buf, false); }
    throw new Error('העלאת ההקלטה לימות נכשלה: ' + (data.message || data.responseStatus));
  }
  return data;
}
const deleteAudio = (name) => call('FileAction', { action: 'delete', what: `ivr2:/${ivrPath()}/${name}.wav` }).catch(() => {});
// מכין הקלטה מלאה (הודעה + תפריט) לפני החיוג. אם משהו נכשל – השיחה תצא כרגיל עם ההקראה של ימות
async function prepareAudio(v) {
  const TTS = require('./tts');
  if (!TTS.enabled() || v.audio_file) return false;
  try {
    let opts = (() => { try { return JSON.parse(v.menu_json || 'null'); } catch (_) { return null; } })();
    if (!opts) {
      let caseIds = []; try { caseIds = JSON.parse(v.case_ids || '[]'); } catch (_) { caseIds = [v.case_id]; }
      const srcIds = [...new Set(caseIds.map((id) => (db.prepare('SELECT source_id FROM cases WHERE id = ?').get(id) || {}).source_id).filter(Boolean))];
      opts = M().buildMenu(srcIds);
      db.prepare('UPDATE voice_calls SET menu_json = ? WHERE id = ?').run(JSON.stringify(opts), v.id);
    }
    const parts = (() => { try { return JSON.parse(v.parts_json || 'null'); } catch (_) { return null; } })() || M().toParts(v.message_text);
    const text = [...parts, ...opts.map((o) => o.text)].join(' ');
    const { buf, seconds } = await TTS.synth(text);
    const name = `v${v.id}`;
    await uploadAudio(name, buf);
    db.prepare('UPDATE voice_calls SET audio_file = ?, message_seconds = ? WHERE id = ?').run(name, seconds, v.id);
    return true;
  } catch (e) {
    console.error('[tts] prepare failed', v.id, e.message);
    db.prepare('UPDATE voice_calls SET error = ? WHERE id = ?').run('ההקלטה המוכנה לא הוכנה (' + e.message + ') – יצא עם הקראת ימות', v.id);
    return false;
  }
}

// ---- מעקב אחרי חלקים שימות כבר הקריאו (ולכן מוכנים אצלם ומתחילים מיד) ----
const warmKey = (t) => require('crypto').createHash('sha1').update(tts(t)).digest('hex');
function markWarm(parts) { const st = db.prepare('INSERT OR IGNORE INTO tts_warm (hash, text) VALUES (?, ?)'); for (const p of (parts || []).filter(Boolean)) st.run(warmKey(p), String(p).slice(0, 300)); }
// חלקים קבועים (לא שם ולא סכום) שימות עוד לא הקריאו אף פעם
const isVariable = (p, i) => i === 0 || /^\d[\d,]*\s*שקלים$/.test(String(p).trim()) || /^\d$/.test(String(p).trim());
function coldParts(parts) { const q = db.prepare('SELECT 1 FROM tts_warm WHERE hash = ?'); return (parts || []).filter((p, i) => p && !isVariable(p, i) && !q.get(warmKey(p))); }
// כמה דקות אחרי שיחה יוצאת, מי שמתקשר מאותו מספר נחשב "אותה שיחה" (ישמע את אותה הודעה). אחר כך – ההודעה המאוחדת המלאה
const callbackWindowDays = () => { const m = +(getSetting('callback_same_minutes') || 5); return Math.max(2, Math.min(120, Number.isFinite(m) ? m : 5)) / 1440; };
// ---- שלוחת ה-API: ימות פונה לכאן בכל שלב בשיחה ----
function handleIvr(q) {
  if (q.key !== getSetting('yemot_ivr_secret')) return 'go_to_folder=hangup';
  const phone = normPhone(q.ApiPhone);
  const callId = String(q.ApiCallId || '').replace(/[^\w-]/g, '');
  const ts = now();
  const SEL = `SELECT v.*, ct.full_name FROM voice_calls v LEFT JOIN contacts ct ON ct.id = v.contact_id`;
  let v = callId ? db.prepare(`${SEL} WHERE v.provider_ref = ? ORDER BY v.id DESC LIMIT 1`).get(callId) : null;
  // שיחה יוצאת שחויגה עכשיו (נכנסה לשלוחה אחרי מענה)
  if (!v && phone) v = db.prepare(`${SEL} WHERE replace(replace(v.phone,'-',''),' ','') = ? AND v.status IN ('sent','sending') AND julianday('now','localtime') - julianday(v.updated_at) < ? ORDER BY v.id DESC LIMIT 1`).get(phone, callbackWindowDays());
  // שיחה נכנסת ממי שיש לו הוראות פתוחות – משמיעים לו את ההודעה האישית המאוחדת
  if (!v && phone && !q.hangup) {
    const ct = db.prepare(`SELECT ct.id FROM contacts ct JOIN cases c ON c.contact_id = ct.id WHERE c.status IN ('new','in_progress','waiting')
      AND ? IN (replace(replace(COALESCE(ct.phone1,''),'-',''),' ',''), replace(replace(COALESCE(ct.phone2,''),'-',''),' ',''), replace(replace(COALESCE(ct.phone3,''),'-',''),' ','')) ORDER BY c.id DESC LIMIT 1`).get(phone);
    if (ct) {
      const m = M().buildMessage(ct.id, { trigger: 'inbound' });
      if (m && m.caseIds.length) {
        const id = db.prepare(`INSERT INTO voice_calls (case_id, contact_id, phone, message_text, parts_json, event_ids, case_ids, trigger, status, provider_ref, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?, 'inbound', 'answered', ?, ?, ?)`).run(m.caseIds[0], ct.id, phone, m.text, JSON.stringify(m.parts), JSON.stringify(m.eventIds), JSON.stringify(m.caseIds), callId || null, ts, ts).lastInsertRowid;
        for (const cid of m.caseIds) db.prepare("INSERT INTO actions (case_id, type, text, created_at) VALUES (?, 'auto_call', ?, ?)").run(cid, `התקשר בעצמו לקו (${phone})`, ts);
        v = db.prepare(`${SEL} WHERE v.id = ?`).get(id);
      }
    }
  }

  // ---------- מתקשר לא מזוהה ----------
  if (!v) {
    if (q.hangup === 'yes') return 'ok';
    const main = M().mainMenu();
    const chosen = main.find((o) => o.digit === String(q.inst || '')) || (main.length === 1 ? main[0] : null);
    const srcId = chosen ? chosen.source_id : null;
    const saveUnknown = (text) => {
      const id = db.prepare('INSERT INTO unknown_messages (phone, recording_url, source_id, transcript, transcript_status) VALUES (?,?,?,?,?)')
        .run(phone, q.rec ? `ivr2:/${ivrPath()}/rec/${callId}.wav` : null, srcId, text || null, sttOn() ? (text ? 'done' : 'failed') : (sttMode() === 'file' ? 'pending' : 'none')).lastInsertRowid;
      if (sttOn()) setTimeout(() => fetchApiVoiceFile(phone, 'unknown_messages', id), 4000);
      else if (sttMode() === 'file' && q.rec) setTimeout(() => transcribeRecording('unknown_messages', id, `ivr2:/${ivrPath()}/rec/${callId}.wav`), 4000);
      notifyUsers([...admins(), ...sourceWorkers(srcId)], null, `הודעה קולית ממספר שאין לו תיק: ${phone}${text ? ' – "' + text.slice(0, 60) + '"' : ''}`);
    };
    if (q.rec || q.msg != null) { saveUnknown(q.msg); return savedReply(); }
    if (main.length > 1 && !chosen) {
      if (q.inst) return readVar('inst', main.map((o) => o.digit), [M().setting('ivr_invalid'), ...menuPrompt(main)]);
      return readVar('inst', main.map((o) => o.digit), [...M().toParts(M().setting('ivr_unknown_greeting')), ...menuPrompt(main)]);
    }
    const opts = M().buildMenu(srcId ? [srcId] : []);
    const pick = opts.find((o) => o.digit === String(q.menu || ''));
    if (pick && pick.type === 'record') return recordCommand(callId);
    if (pick && pick.type === 'transfer') return `id_list_message=${ttsList(pick.transfer)}&routing=${pick.phone}`;
    const head = q.menu ? [M().setting('ivr_invalid')] : (main.length > 1 ? [] : M().toParts(M().setting('ivr_unknown_greeting')));
    return readVar('menu', opts.map((o) => o.digit), [...head, ...menuPrompt(opts)]);
  }

  // ---------- קוד כניסה בשיחה קולית: מקריאים את הקוד פעמיים ומנתקים ----------
  if (v.trigger === 'login_code') {
    if (q.hangup === 'yes') { db.prepare('DELETE FROM voice_calls WHERE id = ?').run(v.id); return 'ok'; }
    const parts = (() => { try { return JSON.parse(v.parts_json || '[]'); } catch (_) { return []; } })();
    db.prepare("UPDATE voice_calls SET status='answered', provider_ref=?, updated_at=? WHERE id=?").run(callId || v.provider_ref, ts, v.id);
    markWarm(parts);
    return `id_list_message=${ttsList(...parts)}&go_to_folder=hangup`;
  }
  // ---------- שיחה מזוהה ----------
  const caseIds = (() => { try { return JSON.parse(v.case_ids || '[]'); } catch (_) { return [v.case_id]; } })();
  const cases = caseIds.map((id) => db.prepare('SELECT id, source_id, assigned_user_id FROM cases WHERE id = ?').get(id)).filter(Boolean);
  const log = (text) => { for (const c of cases) db.prepare("INSERT INTO actions (case_id, type, text, created_at) VALUES (?, 'auto_call', ?, ?)").run(c.id, text, ts); };
  const notify = (msg) => { for (const c of cases) notifyUsers([c.assigned_user_id, ...sourceWorkers(c.source_id)], c.id, msg); };
  let opts = (() => { try { return JSON.parse(v.menu_json || 'null'); } catch (_) { return null; } })();
  if (!opts) { opts = M().buildMenu([...new Set(cases.map((c) => c.source_id).filter(Boolean))]); db.prepare('UPDATE voice_calls SET menu_json = ? WHERE id = ?').run(JSON.stringify(opts), v.id); }

  if (q.hangup === 'yes') {
    if (v.audio_file) { deleteAudio(v.audio_file); db.prepare('UPDATE voice_calls SET audio_file = NULL WHERE id = ?').run(v.id); }
    if (!v.listen_status) {
      const r = finishListen(v, ts, !!v.digit_pressed);
      if (r && !v.digit_pressed) log(`${LISTEN_LABEL[r.st]} (הקשיב כ-${r.secs} שניות${r.pct != null ? ` מתוך כ-${v.message_seconds}, ${r.pct}%` : ''}). לא נבחרה אפשרות בתפריט`);
    }
    if (['sent', 'sending', 'queued', 'answered', 'no_answer'].includes(v.status) && !v.digit_pressed) { db.prepare("UPDATE voice_calls SET status='answered', updated_at=? WHERE id=?").run(ts, v.id); if (!v.answered_at) log('ענה לשיחה. לא נבחרה אפשרות בתפריט'); }
    return 'ok';
  }
  // חזרה מהקלטה / תמלול
  if ((q.rec != null && q.rec !== '') || q.msg != null) {
    const text = q.msg != null ? String(q.msg).trim() : null;
    const pick = opts.find((o) => o.type === 'record');
    db.prepare(`UPDATE voice_calls SET status='replied', digit_pressed=?, recording_url=?, transcript=?, transcript_status=?, record_source_id=?, handled=0, updated_at=? WHERE id=?`)
      .run(pick ? pick.digit : '1', q.rec ? `ivr2:/${ivrPath()}/rec/${callId}.wav` : null, text, sttOn() ? (text ? 'done' : 'failed') : (sttMode() === 'file' ? 'pending' : 'none'), pick ? pick.source_id : null, ts, v.id);
    if (sttOn()) setTimeout(() => fetchApiVoiceFile(phone, 'voice_calls', v.id), 4000);
    else if (sttMode() === 'file' && q.rec) setTimeout(() => transcribeRecording('voice_calls', v.id, `ivr2:/${ivrPath()}/rec/${callId}.wav`), 4000);
    log(`השאיר הודעה קולית${text ? `: "${text.slice(0, 200)}"` : ' (ההקלטה במסך "הודעות קוליות")'}`);
    notify(`${v.full_name || ''} השאיר הודעה קולית`);
    return savedReply();
  }
  // שמע הכל והתפריט נגמר בלי הקשה
  if ('menu' in q && q.menu === '' && v.answered_at) {
    if (!v.listen_status) { finishListen(v, ts, true); log('שמע את כל ההודעה. לא הקיש בתפריט'); }
    return `id_list_message=${ttsList('תודה רבה')}&go_to_folder=hangup`;
  }
  if (!q.menu) {
    const parts = (() => { try { return JSON.parse(v.parts_json || 'null'); } catch (_) { return null; } })() || M().toParts(v.message_text);
    db.prepare("UPDATE voice_calls SET status='answered', provider_ref=?, answered_at=COALESCE(answered_at, ?), message_seconds=COALESCE(message_seconds, ?), updated_at=? WHERE id=?")
      .run(callId || v.provider_ref, ts, estimateSeconds([...parts, ...menuPrompt(opts)]), ts, v.id);
    // מתחילים לדבר מיד: הברכה הקצרה מושמעת ראשונה, ובזמן הזה ימות מכינים את המשך ההודעה (במקום שקט בהתחלה)
    // יש הקלטה מוכנה – מתחילה מיד וברצף
    if (v.audio_file) return `read=f-${v.audio_file}=menu,no,1,1,7,No,yes,no,,${opts.map((o) => o.digit).join('.')},2,,,,no`;
    // ימות מכינים את כל הקול של פקודה לפני שהם מתחילים לדבר. לכן הפקודה הראשונה קצרה: "שלום וברכה" + השם בלבד –
    // מתחילה מהר, ובזמן שהיא מושמעת ימות מכינים את המשך ההודעה (חלקים קבועים כבר שמורים אצלם ומוכנים מיד)
    if (parts.length > 1) {
      // התפריט כחלק נפרד – הפסקה קצרה בין "תודה רבה" ל"להשארת הודעה"
      return `id_list_message=${ttsList(parts[0])}&${readVar('menu', opts.map((o) => o.digit), [...parts.slice(1), ...menuPrompt(opts)])}`;
    }
    return readVar('menu', opts.map((o) => o.digit), [...parts, ...menuPrompt(opts)]);
  }
  const pick = opts.find((o) => o.digit === String(q.menu));
  if (pick && !v.listen_status) finishListen(v, ts, true);
  if (pick && pick.type === 'record') return recordCommand(callId);
  if (pick && pick.type === 'transfer') {
    db.prepare("UPDATE voice_calls SET status='replied', digit_pressed=?, updated_at=? WHERE id=?").run(pick.digit, ts, v.id);
    // מתעדים רק בתיקים של המוסד שאליו עבר
    const target = cases.filter((c) => !pick.source_id || c.source_id === pick.source_id);
    const name = M().sourceConfig(pick.source_id ? db.prepare('SELECT * FROM sources WHERE id = ?').get(pick.source_id) : null).institution;
    for (const c of (target.length ? target : cases)) {
      db.prepare("INSERT INTO actions (case_id, type, text, created_at) VALUES (?, 'auto_call', ?, ?)").run(c.id, `עבר לשיחה עם ${pick.to_label || 'משרדי ' + name} (${pick.phone})`, ts);
      notifyUsers([c.assigned_user_id, ...sourceWorkers(c.source_id)], c.id, `${v.full_name || ''} הועבר בטלפון למשרדי ${name}`);
    }
    return `id_list_message=${ttsList(pick.transfer)}&routing=${pick.phone}`;
  }
  return readVar('menu', opts.map((o) => o.digit), [M().setting('ivr_invalid'), ...menuPrompt(opts)]);
}

module.exports = { markWarm, coldParts, prepareAudio, uploadAudio, syncIvrIfChanged, sttMode, sweepMissingFiles, configured, testConnection, installIvr, runCampaign, runPersonal, sendPersonal, personalLine, bridgeCalls, downloadFile, handleIvr, ivrPath, ivrSecret, resetToken, normPhone, retranscribe, REC_DIR, call };
