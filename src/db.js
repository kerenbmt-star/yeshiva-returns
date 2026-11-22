// מסד הנתונים: SQLite בקובץ אחד (data/returns.db)
// הפרדה ברורה: contacts = נתוני האדם, return_events = אירועי החיוב החוזר, cases = תיק הטיפול.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'returns.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// גיבוי חד-פעמי של מסד הנתונים לפני שדרוג המבנה (נשמר ב-data/backups)
try {
  const marker = path.join(DATA_DIR, 'pre-upgrade-2026-11-10.done');
  if (!fs.existsSync(marker) && db.prepare("SELECT 1 FROM sqlite_master WHERE name='cases'").get()) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
    fs.copyFileSync(DB_PATH, path.join(DATA_DIR, 'backups', 'pre-upgrade-2026-11-10.db'));
    fs.writeFileSync(marker, new Date().toISOString());
  }
} catch (e) { console.error('[backup before upgrade]', e.message); }
db.pragma('foreign_keys = ON');

const STATUSES = {
  new: 'חדש',
  in_progress: 'בטיפול',
  waiting: 'ממתין לחודש הבא',
  resolved: 'טופל',
  unresolvable: 'לא ניתן לטיפול',
};
const OPEN_STATUSES = ['new', 'in_progress', 'waiting'];

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  username TEXT UNIQUE,
  email TEXT,
  phone TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('admin','worker')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS tts_warm (
  hash TEXT PRIMARY KEY,
  text TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  full_name TEXT,
  phone1 TEXT,
  phone2 TEXT,
  phone3 TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  extra_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'new',
  assigned_user_id INTEGER REFERENCES users(id),
  next_followup_date TEXT,
  last_action_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cases_contact ON cases(contact_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  filename TEXT,
  file_hash TEXT,
  sheet_name TEXT,
  period_label TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  rows_total INTEGER DEFAULT 0,
  rows_imported INTEGER DEFAULT 0,
  rows_duplicate INTEGER DEFAULT 0,
  rows_error INTEGER DEFAULT 0,
  cases_created INTEGER DEFAULT 0,
  cases_updated INTEGER DEFAULT 0,
  contacts_created INTEGER DEFAULT 0,
  total_amount REAL DEFAULT 0,
  mapping_json TEXT,
  errors_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS return_events (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  case_id INTEGER NOT NULL REFERENCES cases(id),
  import_id INTEGER REFERENCES imports(id),
  charge_date TEXT,
  amount REAL NOT NULL DEFAULT 0,
  reason TEXT,
  reason_code TEXT,
  reference TEXT,
  bank TEXT,
  branch TEXT,
  account TEXT,
  raw_json TEXT,
  dedup_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_events_case ON return_events(case_id);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,
  text TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_actions_case ON actions(case_id);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  from_user_id INTEGER REFERENCES users(id),
  to_user_id INTEGER REFERENCES users(id),
  by_user_id INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  case_id INTEGER REFERENCES cases(id),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  dedup_key TEXT UNIQUE,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY,
  to_user_id INTEGER REFERENCES users(id),
  to_email TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS call_queue (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  phone TEXT NOT NULL,
  message_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_ref TEXT,
  error TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  done_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---- הרחבות שלב 1: סוגי קבצים, סעיף חיוב, אמצעי תשלום, תוצאות שיחה, הודעות קוליות ----
db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'returns' CHECK (kind IN ('returns','payment_methods')),
  default_assignee_id INTEGER REFERENCES users(id),
  mapping_json TEXT,
  callback_phone TEXT,
  voice_message TEXT,
  nedarim_target TEXT,
  callback_days INTEGER DEFAULT 3,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS user_sources (
  user_id INTEGER NOT NULL REFERENCES users(id),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  PRIMARY KEY (user_id, source_id)
);
CREATE TABLE IF NOT EXISTS voice_calls (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  phone TEXT NOT NULL,
  message_text TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 1,
  digit_pressed TEXT,
  recording_url TEXT,
  callback_date TEXT,
  provider_ref TEXT,
  error TEXT,
  handled INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS deleted_records (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref_id INTEGER, snapshot_json TEXT, reason TEXT,
  deleted_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS suppressed_keys (dedup_key TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
`);
db.exec(`CREATE TABLE IF NOT EXISTS unknown_messages (id INTEGER PRIMARY KEY, phone TEXT, recording_url TEXT, handled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))`);
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('cases', 'source_id', 'INTEGER REFERENCES sources(id)');
addColumn('cases', 'followup_time', 'TEXT');
addColumn('cases', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
addColumn('return_events', 'source_id', 'INTEGER REFERENCES sources(id)');
addColumn('return_events', 'charge_item', 'TEXT');
addColumn('return_events', 'payment_method', 'TEXT');
addColumn('return_events', 'method_status', 'TEXT');
addColumn('return_events', 'expiry', 'TEXT');
addColumn('actions', 'outcome', 'TEXT');
addColumn('imports', 'source_id', 'INTEGER REFERENCES sources(id)');
addColumn('contacts', 'bad_phones', 'TEXT');
addColumn('voice_calls', 'scheduled_for', 'TEXT');
addColumn('voice_calls', 'campaign_id', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_cases_source ON cases(source_id)');

// ---- שדרוג: מוקד טלפוני לפי מוסד, הודעות מאוחדות, תזכורות, הרשאות, תמלול ----
addColumn('sources', 'config_json', 'TEXT');            // תפריט טלפוני, נוסחים ותזכורות לכל מוסד
addColumn('return_events', 'status', "TEXT NOT NULL DEFAULT 'open'"); // סטטוס לכל הוראת קבע בנפרד
addColumn('return_events', 'resolved_at', 'TEXT');
addColumn('voice_calls', 'contact_id', 'INTEGER');
// מעקב האזנה: מתי ענה, כמה שניות הקשיב, אורך ההודעה המשוער, והאם שמע הכל / ניתק באמצע
addColumn('voice_calls', 'answered_at', 'TEXT');
addColumn('sessions', 'via', 'TEXT');
addColumn('voice_calls', 'wait_for', 'INTEGER'); // לחכות לשיחת חימום לפני שהשיחה יוצאת // password / code / google
addColumn('voice_calls', 'audio_file', 'TEXT'); // הקלטה מוכנה שהועלתה לימות לפני החיוג
addColumn('voice_calls', 'listened_seconds', 'INTEGER');
addColumn('voice_calls', 'message_seconds', 'INTEGER');
addColumn('voice_calls', 'listen_status', 'TEXT'); // full / partial / early
addColumn('voice_calls', 'trigger', "TEXT NOT NULL DEFAULT 'manual'"); // manual / auto_reminder / monthly_no_method / expiry / inbound
addColumn('voice_calls', 'reminder_no', 'INTEGER');
addColumn('voice_calls', 'event_ids', 'TEXT');
addColumn('voice_calls', 'case_ids', 'TEXT');
addColumn('voice_calls', 'parts_json', 'TEXT');
addColumn('voice_calls', 'menu_json', 'TEXT');
addColumn('voice_calls', 'transcript', 'TEXT');
addColumn('voice_calls', 'transcript_status', "TEXT NOT NULL DEFAULT 'none'");
addColumn('voice_calls', 'local_file', 'TEXT');
addColumn('voice_calls', 'record_source_id', 'INTEGER');
addColumn('unknown_messages', 'source_id', 'INTEGER');
addColumn('unknown_messages', 'transcript', 'TEXT');
addColumn('unknown_messages', 'transcript_status', "TEXT NOT NULL DEFAULT 'none'");
addColumn('unknown_messages', 'local_file', 'TEXT');
addColumn('users', 'permissions_json', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS auto_sends (key TEXT PRIMARY KEY, contact_id INTEGER, kind TEXT, voice_call_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))`);
// תיקים שכבר נסגרו – כל ההוראות שלהם מסומנות כהוסדרו
db.exec(`UPDATE return_events SET status='resolved', resolved_at=COALESCE(resolved_at,(SELECT resolved_at FROM cases c WHERE c.id = return_events.case_id))
  WHERE status='open' AND case_id IN (SELECT id FROM cases WHERE status IN ('resolved','unresolvable'))`);
// שיחות קיימות – משייכים לאיש הקשר
db.exec(`UPDATE voice_calls SET contact_id = (SELECT contact_id FROM cases c WHERE c.id = voice_calls.case_id) WHERE contact_id IS NULL`);

// ברירות מחדל להגדרות
const defaults = {
  stale_days: '7',
  new_contact_days: '3', escalate_days: '7', morning_hour: '8', nudge_hour: '13', urgent_hours: '3',
  email_provider: '', brevo_api_key: '', email_from_name: 'ישיבת סלונים',
  org_name: 'ישיבת סלונים',
  smtp_host: '', smtp_port: '587', smtp_secure: '0', smtp_user: '', smtp_pass: '', smtp_from: '',
  email_enabled: '0',
  phone_provider: '', phone_api_url: '', phone_api_key: '', phone_caller_id: '',
  phone_message: 'שלום וברכה, כאן ישיבת סלונים. הוראת הקבע שלך לא כובדה והתשלום לא הושלם. נשמח אם תסדיר את התשלום בהקדם. תודה ותזכו למצוות.',
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v);

// ירון רוטנברג – מטפל קיים (ללא סיסמה עד שמנהל יגדיר לו)
const yaron = db.prepare('SELECT id FROM users WHERE full_name = ?').get('ירון רוטנברג');
if (!yaron) db.prepare("INSERT INTO users (full_name, role) VALUES ('ירון רוטנברג', 'worker')").run();

// סוגי קבצים התחלתיים (רק אם עוד לא הוגדר אף סוג)
if (!db.prepare('SELECT 1 FROM sources').get()) {
  const y = db.prepare('SELECT id FROM users WHERE full_name = ?').get('ירון רוטנברג');
  db.prepare("INSERT INTO sources (name, kind, default_assignee_id) VALUES ('החזרות ישיבה', 'returns', ?)").run(y ? y.id : null);
  db.prepare("INSERT INTO sources (name, kind) VALUES ('חסרי אמצעי תשלום', 'payment_methods')").run();
}

// עדכון נוסח ישן ששמור במסד (בלי "חזר מהבנק")
db.prepare("UPDATE settings SET value = ? WHERE key = 'phone_message' AND value LIKE '%מהבנק%'").run('שלום וברכה, כאן ישיבת סלונים. הוראת הקבע שלך לא כובדה והתשלום לא הושלם. נשמח אם תסדיר את התשלום בהקדם. תודה ותזכו למצוות.');

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? '' : String(value));
}
function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function today() { return now().slice(0, 10); }
function heDate(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || ''); }

module.exports = { db, DB_PATH, DATA_DIR, STATUSES, OPEN_STATUSES, getSetting, setSetting, now, today, heDate };
