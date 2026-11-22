// הכנת הקלטה מוכנה של ההודעה (Google Text-to-Speech) לפני החיוג – כדי שההודעה תתחיל מיד כשעונים ותישמע ברצף
const { getSetting } = require('./db');
const GBASE = process.env.GOOGLE_TTS_BASE || 'https://texttospeech.googleapis.com/v1/';
const VOICES = ['he-IL-Wavenet-D', 'he-IL-Wavenet-B', 'he-IL-Standard-D', 'he-IL-Standard-B'];
const enabled = () => !!getSetting('google_tts_key');
const voice = () => (VOICES.includes(getSetting('google_tts_voice')) ? getSetting('google_tts_voice') : VOICES[0]);
// אותה הגדרת מהירות כמו בימות (‎-10 עד 10) → מהירות דיבור של גוגל
const speakingRate = () => { const n = parseInt(getSetting('tts_rate') ?? '0', 10); return Math.max(0.6, Math.min(1.6, 1 + (Number.isFinite(n) ? n : 0) * 0.04)); };

// מחזיר קובץ WAV (‏8000Hz מונו – איכות טלפון) ואורכו בשניות
async function synth(text) {
  const key = getSetting('google_tts_key');
  if (!key) throw new Error('לא הוגדר מפתח של גוגל');
  const r = await fetch(`${GBASE}text:synthesize?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { text: String(text).slice(0, 2400) }, voice: { languageCode: 'he-IL', name: voice() },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000, speakingRate: speakingRate() } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.audioContent) {
    const msg = (j.error && j.error.message) || `שגיאה ${r.status}`;
    if (/API key not valid|API_KEY_INVALID/i.test(msg)) throw new Error('המפתח של גוגל לא תקין');
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) throw new Error('צריך להפעיל את Text-to-Speech בחשבון גוגל');
    if (/billing/i.test(msg)) throw new Error('צריך לחבר אמצעי תשלום לחשבון גוגל (אין חיוב עד הכמות החינמית)');
    throw new Error('גוגל: ' + msg);
  }
  const buf = Buffer.from(j.audioContent, 'base64');
  return { buf, seconds: Math.round(Math.max(0, buf.length - 44) / 16000) };
}
module.exports = { enabled, synth, VOICES };
