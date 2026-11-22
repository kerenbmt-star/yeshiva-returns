// תמלול חינמי בתוך המערכת: מנהל תהליך-עובד אחד, תור עבודות, וכיבוי אחרי זמן ללא שימוש (חוסך זיכרון ועלות)
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./db');
const CACHE = path.join(DATA_DIR, 'models');
fs.mkdirSync(CACHE, { recursive: true });
let child = null, idleTimer = null, seq = 0;
const pending = new Map();
function start() {
  child = fork(path.join(__dirname, 'stt-worker.mjs'), [], { env: { ...process.env, STT_CACHE: CACHE }, execArgv: ['--max-old-space-size=4096'] });
  child.on('message', (m) => {
    if (m.ready) return;
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.text);
    armIdle();
  });
  child.on('exit', (code) => {
    child = null;
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('תהליך התמלול נעצר (' + code + ')')); pending.delete(id); }
  });
}
function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (child && !pending.size) child.kill(); }, 3 * 60e3);
}
function transcribeFile(file) {
  if (!child) start();
  clearTimeout(idleTimer);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('התמלול לקח יותר מדי זמן')); if (child) child.kill(); }, 15 * 60e3);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, file });
  });
}
module.exports = { transcribeFile };
