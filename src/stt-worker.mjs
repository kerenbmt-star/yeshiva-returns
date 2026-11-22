// תהליך נפרד לתמלול עברית חינמי (מודל ivrit-ai שרץ בתוך השרת). אם ייגמר לו הזיכרון – רק הוא נופל, האתר ממשיך לעבוד.
import { pipeline, env } from '@huggingface/transformers';
import { execFileSync } from 'child_process';
import ff from 'ffmpeg-static';
env.cacheDir = process.env.STT_CACHE;
const MODEL = process.env.STT_MODEL || 'ivrit-ai/whisper-large-v3-turbo-onnx';
let asr = null;
async function load() {
  if (!asr) asr = await pipeline('automatic-speech-recognition', MODEL, { dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' } });
  return asr;
}
// חיתוך ההקלטה במקומות של שקט, לקטעים של עד 25 שניות – כך שום חלק לא נבלע
function segments(file) {
  const raw = execFileSync(ff, ['-loglevel', 'error', '-i', file, '-ar', '16000', '-ac', '1', '-f', 'f32le', 'pipe:1'], { maxBuffer: 2e9 });
  const audio = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  const SR = 16000, MAX = 25 * SR, WIN = 0.05 * SR;
  const out = [];
  let start = 0;
  while (audio.length - start > MAX) {
    // מחפשים את הרגע השקט ביותר בין 12 ל-25 שניות
    let best = start + MAX, bestE = Infinity;
    for (let p = start + 12 * SR; p + WIN < start + MAX; p += WIN) {
      let e = 0; for (let i = p; i < p + WIN; i++) e += audio[i] * audio[i];
      if (e < bestE) { bestE = e; best = p + WIN / 2; }
    }
    out.push(audio.subarray(start, best)); start = best;
  }
  if (audio.length - start > 0.3 * SR) out.push(audio.subarray(start));
  return out;
}
process.on('message', async ({ id, file }) => {
  try {
    const a = await load();
    const parts = [];
    for (const seg of segments(file)) {
      const r = await a(seg, { language: 'hebrew', task: 'transcribe', max_new_tokens: 440 });
      const t = String(r.text || '').trim(); if (t) parts.push(t);
    }
    process.send({ id, text: parts.join(' ') });
  } catch (e) { process.send({ id, error: e.message }); }
});
process.send({ ready: true });
