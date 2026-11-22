// קליטת קבצי Excel/CSV: זיהוי שורת כותרת, זיהוי עמודות חכם, איחוד לתיקים ומניעת כפילויות
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const { db, now } = require('./db');

// שדות המערכת ומילות מפתח לזיהוי לפי כותרת (הכותרת מנורמלת: ללא רווחים כפולים, גרשיים ונקודות)
const FIELDS = {
  external_id: { label: 'מזהה איש קשר', required: true, keys: ['מזהה איש קשר', 'מזהה אש קשר', 'מס איש קשר', 'קוד איש קשר', 'מספר איש קשר', 'איש קשר מזהה', 'מזהה תורם', 'קוד תורם', 'מס תורם', 'מספר תורם', 'מזהה לקוח', 'קוד לקוח', 'מס לקוח', 'מספר לקוח', 'contact id', 'contactid', 'customer id', 'מזהה'] },
  full_name: { label: 'שם מלא', keys: ['שם מלא', 'שם איש קשר', 'שם התורם', 'שם תורם', 'שם לקוח', 'שם הלקוח', 'שם בעל החשבון', 'שם', 'full name', 'name'] },
  first_name: { label: 'שם פרטי', keys: ['שם פרטי', 'first name'] },
  last_name: { label: 'שם משפחה', keys: ['שם משפחה', 'משפחה', 'last name'] },
  phone1: { label: 'טלפון 1', keys: ['טלפון נייד', 'נייד', 'פלאפון', 'סלולרי', 'טלפון 1', 'טלפון1', 'טלפון', 'טל', 'mobile', 'phone'] },
  phone2: { label: 'טלפון 2', keys: ['טלפון 2', 'טלפון2', 'טלפון בית', 'טלפון נוסף', 'נייד 2', 'טלפון קווי'] },
  phone3: { label: 'טלפון 3', keys: ['טלפון 3', 'טלפון3', 'טלפון עבודה'] },
  email: { label: 'דוא"ל', keys: ['דואל', 'דוא ל', 'אימייל', 'מייל', 'email', 'e-mail'] },
  address: { label: 'כתובת', keys: ['כתובת מלאה', 'כתובת', 'רחוב', 'address'] },
  city: { label: 'עיר', keys: ['עיר', 'ישוב', 'יישוב', 'city'] },
  amount: { label: 'סכום', required: 'returns', keys: ['סכום חיוב', 'סכום החיוב', 'סכום שחזר', 'סכום ההחזרה', 'סכום החזרה', 'סכום לחיוב', 'סכום', 'סך', 'amount'] },
  charge_date: { label: 'תאריך חיוב', keys: ['תאריך חיוב', 'תאריך החיוב', 'תאריך ערך', 'תאריך החזרה', 'תאריך', 'date'] },
  charge_item: { label: 'סעיף / סיווג תרומה', keys: ['סעיף חיוב', 'סעיף החיוב', 'סיווג תרומה', 'סיווג התרומה', 'סעיף פיננסי', 'סיווג', 'מטרת החיוב', 'מטרת התרומה', 'סוג חיוב', 'סוג תרומה', 'סעיף', 'מטרה', 'פרויקט', 'קרן', 'תיאור חיוב'] },
  payment_method: { label: 'אמצעי תשלום', keys: ['אמצעי תשלום', 'סוג אמצעי תשלום', 'אמצעי גבייה', 'אמצעי', 'סוג תשלום', 'כרטיס אשראי'] },
  method_status: { label: 'מצב אמצעי התשלום', keys: ['סטטוס אמצעי תשלום', 'מצב אמצעי תשלום', 'סטטוס הרשאה', 'מצב הרשאה', 'סטטוס כרטיס', 'סטטוס'] },
  expiry: { label: 'תוקף', keys: ['תוקף כרטיס', 'תוקף', 'תאריך תפוגה', 'expiry'] },
  reason: { label: 'סיבת החזרה', keys: ['סיבת החזרה', 'סיבת ההחזרה', 'תיאור החזרה', 'סיבת דחייה', 'סיבה', 'תיאור שגיאה', 'הודעת בנק', 'reason'] },
  reason_code: { label: 'קוד החזרה', keys: ['קוד החזרה', 'קוד סיבה', 'קוד דחייה', 'קוד שגיאה'] },
  reference: { label: 'אסמכתא / מס הוראה', keys: ['אסמכתא', 'מס הוראה', 'מספר הוראה', 'מזהה הוראה', 'מס הרשאה', 'מספר הרשאה', 'מס חיוב', 'מזהה חיוב', 'reference'] },
  bank: { label: 'בנק', keys: ['בנק', 'קוד בנק', 'מס בנק'] },
  branch: { label: 'סניף', keys: ['סניף', 'מס סניף'] },
  account: { label: 'חשבון', keys: ['מס חשבון', 'מספר חשבון', 'חשבון'] },
};

function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[֑-ׇ]/g, '') // ניקוד
    .replace(/["'`׳״.:_\-\/\\()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ניקוד התאמה בין כותרת לשדה: התאמה מלאה > מתחיל ב > מכיל
function scoreHeader(header, field) {
  const h = norm(header);
  if (!h) return 0;
  let best = 0;
  FIELDS[field].keys.forEach((k, idx) => {
    const key = norm(k);
    const weight = 1 - idx * 0.01; // מילים ראשונות ברשימה ספציפיות יותר
    let s = 0;
    if (h === key) s = 100;
    else if (h.startsWith(key + ' ') || h.endsWith(' ' + key)) s = 70;
    else if (key.length >= 3 && h.includes(key)) s = 50;
    s *= weight;
    if (s > best) best = s;
  });
  return best;
}

function guessMapping(headers) {
  // הקצאה חמדנית: הזוג (שדה, עמודה) עם הניקוד הגבוה ביותר קודם
  const pairs = [];
  headers.forEach((h, col) => {
    for (const f of Object.keys(FIELDS)) {
      const s = scoreHeader(h, f);
      if (s > 0) pairs.push({ f, col, s });
    }
  });
  pairs.sort((a, b) => b.s - a.s);
  const mapping = {};
  const usedCols = new Set();
  for (const p of pairs) {
    if (mapping[p.f] != null || usedCols.has(p.col)) continue;
    mapping[p.f] = p.col;
    usedCols.add(p.col);
  }
  // אם יש שם פרטי+משפחה ואין שם מלא – בסדר; אם יש שם מלא – לא צריך את השאר
  return mapping;
}

function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.result !== undefined) return cellValue(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return v.text;
    if (v.hyperlink) return v.text || v.hyperlink;
    return null;
  }
  return v;
}

async function readWorkbook(buffer, filename) {
  const wb = new ExcelJS.Workbook();
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.csv')) {
    let text = buffer.toString('utf8');
    if (text.includes('�')) text = new TextDecoder('windows-1255').decode(buffer);
    await wb.csv.read(Readable.from([text]));
  } else if (lower.endsWith('.xls')) {
    throw new Error('קבצי ‎.xls‎ (פורמט ישן) אינם נתמכים. יש לפתוח את הקובץ ב-Excel ולשמור בשם כ-‎.xlsx‎ ולהעלות שוב.');
  } else {
    await wb.xlsx.load(buffer);
  }
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellValue(row.getCell(c).value));
      if (vals.some((v) => v !== null && String(v).trim() !== '')) { vals.rowNumber = row.number; rows.push(vals); }
    });
    sheets.push({ name: ws.name, rows });
  });
  return sheets;
}

// מציאת שורת הכותרת: השורה (מבין 20 הראשונות) עם הכי הרבה התאמות לשדות
function findHeaderRow(rows) {
  let best = { idx: 0, score: -1 };
  rows.slice(0, 20).forEach((r, idx) => {
    const m = guessMapping(r.map((x) => (x instanceof Date ? '' : x)));
    const score = Object.keys(m).length + (m.external_id != null ? 3 : 0) + (m.amount != null ? 2 : 0);
    if (score > best.score) best = { idx, score };
  });
  return best.idx;
}

function mappingFromSaved(headers, saved) {
  if (!saved) return null;
  const m = {};
  for (const [f, h] of Object.entries(saved)) { const i = headers.indexOf(h); if (i >= 0) m[f] = i; }
  return Object.keys(m).length ? m : null;
}

async function analyze(buffer, filename, savedMapping) {
  const sheets = await readWorkbook(buffer, filename);
  const usable = sheets.filter((s) => s.rows.length > 0);
  if (!usable.length) throw new Error('הקובץ ריק – לא נמצאו שורות נתונים.');
  const result = usable.map((s) => {
    const headerIdx = findHeaderRow(s.rows);
    const headers = s.rows[headerIdx].map((h, i) => (h == null || String(h).trim() === '' ? `עמודה ${i + 1}` : String(h).trim()));
    const mapping = mappingFromSaved(headers, savedMapping) || guessMapping(headers);
    const dataRows = s.rows.slice(headerIdx + 1);
    return {
      fromSaved: !!mappingFromSaved(headers, savedMapping),
      sheet: s.name,
      headerRow: s.rows[headerIdx].rowNumber || headerIdx + 1,
      headers,
      mapping,
      rowCount: dataRows.length,
      sample: dataRows.slice(0, 8).map((r) => r.map(display)),
    };
  });
  // הגיליון המומלץ: זה שבו זוהו מזהה וסכום ויש הכי הרבה שורות
  result.sort((a, b) => scoreSheet(b) - scoreSheet(a));
  return { sheets: result, fields: Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, { label: v.label, required: v.required || false }])) };
}
function scoreSheet(s) {
  return (s.mapping.external_id != null ? 1e6 : 0) + (s.mapping.amount != null ? 1e5 : 0) + s.rowCount;
}

function display(v) {
  if (v == null) return '';
  if (v instanceof Date) return toIsoDate(v);
  return String(v);
}

function toIsoDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    // ExcelJS מחזיר תאריכים ב-UTC
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // מספר סידורי של Excel
    return toIsoDate(new Date(Math.round((v - 25569) * 86400 * 1000)));
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    return `${y}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  return s; // משאירים כפי שהוא אם לא זוהה
}

function toAmount(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.abs(v);
  const s = String(v).replace(/[₪,\s]/g, '').replace(/[^\d.\-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.abs(n);
}

// הגנה: לעולם לא שומרים מספר כרטיס מלא או קוד אבטחה
const SENSITIVE_HEADER = /cvv|cvc|קוד אבטחה|3 ספרות|ספרות בגב/i;
function maskSensitive(v) {
  if (v == null) return v;
  const s = String(v).replace(/[\s-]/g, '');
  if (/^\d{13,19}$/.test(s)) return '****' + s.slice(-4);
  return v;
}

function cleanId(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(Math.round(v));
  return String(v).trim();
}
function cleanPhone(v) {
  if (v == null) return null;
  let s = typeof v === 'number' ? String(v) : String(v).trim();
  if (!s) return null;
  if (/^\d{8,9}$/.test(s) && !s.startsWith('0')) s = '0' + s; // אפס מוביל שנבלע ב-Excel
  return s;
}
function str(v) {
  if (v == null) return null;
  const s = display(v).trim();
  return s === '' ? null : s;
}

// ביצוע הייבוא בפועל
async function runImport({ buffer, filename, sheetName, mapping, periodLabel, userId, source }) {
  const isReturns = !source || source.kind === 'returns';
  const sheets = await readWorkbook(buffer, filename);
  const sheet = sheets.find((s) => s.name === sheetName) || sheets[0];
  if (!sheet) throw new Error('לא נמצא גיליון בקובץ');
  const headerIdx = findHeaderRow(sheet.rows);
  const headers = sheet.rows[headerIdx].map((h, i) => (h == null || String(h).trim() === '' ? `עמודה ${i + 1}` : String(h).trim()));
  const dataRows = sheet.rows.slice(headerIdx + 1);

  if (mapping.external_id == null || mapping.external_id === '') throw new Error('חובה למפות עמודת "מזהה איש קשר" – האיחוד לתיקים נעשה לפיה.');
  if (isReturns && (mapping.amount == null || mapping.amount === '')) throw new Error('חובה למפות עמודת "סכום".');

  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const get = (row, f) => (mapping[f] == null || mapping[f] === '' ? null : row[+mapping[f]]);
  const mappedCols = new Set(Object.values(mapping).filter((x) => x !== '' && x != null).map(Number));

  const stats = { rows_total: 0, rows_imported: 0, rows_duplicate: 0, rows_error: 0, cases_created: 0, cases_updated: 0, contacts_created: 0, total_amount: 0, duplicate_amount: 0 };
  const errors = [];
  const occurrence = new Map();

  const q = {
    findContact: db.prepare('SELECT * FROM contacts WHERE external_id = ?'),
    insContact: db.prepare('INSERT INTO contacts (external_id, full_name, phone1, phone2, phone3, email, address, city, extra_json) VALUES (?,?,?,?,?,?,?,?,?)'),
    updContact: db.prepare(`UPDATE contacts SET full_name = COALESCE(?, full_name), phone1 = COALESCE(?, phone1), phone2 = COALESCE(?, phone2),
      phone3 = COALESCE(?, phone3), email = COALESCE(?, email), address = COALESCE(?, address), city = COALESCE(?, city), updated_at = ? WHERE id = ?`),
    openCase: db.prepare("SELECT * FROM cases WHERE contact_id = ? AND COALESCE(source_id, 0) = ? AND status IN ('new','in_progress','waiting') ORDER BY id DESC LIMIT 1"),
    insCase: db.prepare("INSERT INTO cases (contact_id, status, created_at, updated_at, source_id, assigned_user_id) VALUES (?, 'new', ?, ?, ?, ?)"),
    insAssign: db.prepare('INSERT INTO assignments (case_id, from_user_id, to_user_id, by_user_id, note, created_at) VALUES (?,?,?,?,?,?)'),
    touchCase: db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?'),
    dupCheck: db.prepare('SELECT 1 FROM return_events WHERE dedup_key = ? UNION ALL SELECT 1 FROM suppressed_keys WHERE dedup_key = ?'),
    insEvent: db.prepare(`INSERT INTO return_events (contact_id, case_id, import_id, charge_date, amount, reason, reason_code, reference, bank, branch, account, raw_json, dedup_key,
      source_id, charge_item, payment_method, method_status, expiry) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    insAction: db.prepare('INSERT INTO actions (case_id, user_id, type, text, created_at) VALUES (?,?,?,?,?)'),
    insImport: db.prepare('INSERT INTO imports (filename, file_hash, sheet_name, period_label, uploaded_by, mapping_json, source_id) VALUES (?,?,?,?,?,?,?)'),
    updImport: db.prepare(`UPDATE imports SET rows_total=?, rows_imported=?, rows_duplicate=?, rows_error=?, cases_created=?, cases_updated=?, contacts_created=?, total_amount=?, errors_json=? WHERE id=?`),
  };

  const tx = db.transaction(() => {
    const ts = now();
    const sourceId = source ? source.id : 0;
    const importId = q.insImport.run(filename, fileHash, sheet.name, periodLabel || null, userId, JSON.stringify({ mapping, headers }), source ? source.id : null).lastInsertRowid;
    const touchedCases = new Map(); // caseId -> {created, added, amount}

    dataRows.forEach((row, i) => {
      const rowNum = row.rowNumber || headerIdx + 2 + i;
      const extId = cleanId(get(row, 'external_id'));
      const amount = isReturns ? toAmount(get(row, 'amount')) : (toAmount(get(row, 'amount')) || 0);
      const isBlank = row.every((v) => v == null || String(v).trim() === '');
      if (isBlank) return;
      // שורת סיכום בתחתית הקובץ (ללא מזהה) – מדלגים בלי לספור כשגיאה
      // שורת סיכום (למשל 'סה"כ סכום: 10540 לפי אופן תשלום') – מדלגים
      if (/סה"?כ|סה״כ|סיכום|total/i.test(extId) || (!extId && row.some((v) => /סה"?כ|סה״כ|סיכום|total/i.test(String(v || ''))))) return;
      stats.rows_total++;
      if (!extId) { stats.rows_error++; errors.push({ row: rowNum, error: 'חסר מזהה איש קשר' }); return; }
      if (amount == null) { stats.rows_error++; errors.push({ row: rowNum, error: 'סכום לא תקין' }); return; }

      let fullName = str(get(row, 'full_name'));
      if (!fullName) fullName = [str(get(row, 'first_name')), str(get(row, 'last_name'))].filter(Boolean).join(' ') || null;
      const chargeDate = toIsoDate(get(row, 'charge_date'));
      const reason = str(get(row, 'reason'));
      const reasonCode = str(get(row, 'reason_code'));
      const reference = str(get(row, 'reference'));
      const extra = {};
      headers.forEach((h, c) => { if (SENSITIVE_HEADER.test(h)) return; if (!mappedCols.has(c) && row[c] != null && String(row[c]).trim() !== '') extra[h] = maskSensitive(display(row[c])); });
      const raw = {};
      headers.forEach((h, c) => { if (SENSITIVE_HEADER.test(h)) return; if (row[c] != null && String(row[c]).trim() !== '') raw[h] = maskSensitive(display(row[c])); });
      const chargeItem = str(get(row, 'charge_item'));
      const payMethod = maskSensitive(str(get(row, 'payment_method')));
      const methodStatus = str(get(row, 'method_status'));
      const expiry = str(get(row, 'expiry'));

      // מפתח כפילות: תוכן החיוב + מספר מופע זהה בתוך הקובץ (כך שייבוא חוזר של אותו קובץ מזוהה ככפול,
      // אבל שני חיובים זהים באמת באותו קובץ לא נבלעים)
      const base = [sourceId, extId, chargeDate || '', amount.toFixed(2), reason || '', reasonCode || '', reference || '', str(get(row, 'account')) || '', chargeItem || '', payMethod || '', methodStatus || ''].join('|');
      const occ = (occurrence.get(base) || 0) + 1;
      occurrence.set(base, occ);
      const dedupKey = crypto.createHash('sha1').update(base + '#' + occ).digest('hex');
      if (q.dupCheck.get(dedupKey, dedupKey)) { stats.rows_duplicate++; stats.duplicate_amount += amount; return; }

      let contact = q.findContact.get(extId);
      const p1 = cleanPhone(get(row, 'phone1')), p2 = cleanPhone(get(row, 'phone2')), p3 = cleanPhone(get(row, 'phone3'));
      const email = str(get(row, 'email')), address = str(get(row, 'address')), city = str(get(row, 'city'));
      if (!contact) {
        const id = q.insContact.run(extId, fullName, p1, p2, p3, email, address, city, Object.keys(extra).length ? JSON.stringify(extra) : null).lastInsertRowid;
        contact = { id };
        stats.contacts_created++;
      } else {
        q.updContact.run(fullName, p1, p2, p3, email, address, city, ts, contact.id);
      }

      let kase = q.openCase.get(contact.id, sourceId);
      if (!kase) {
        const assignee = source && source.default_assignee_id ? source.default_assignee_id : null;
        const id = q.insCase.run(contact.id, ts, ts, source ? source.id : null, assignee).lastInsertRowid;
        if (assignee) q.insAssign.run(id, null, assignee, userId, `שיוך אוטומטי לאחראי "${source.name}"`, ts);
        kase = { id };
        touchedCases.set(id, { created: true, added: 0, amount: 0 });
        stats.cases_created++;
      } else if (!touchedCases.has(kase.id)) {
        touchedCases.set(kase.id, { created: false, added: 0, amount: 0 });
        stats.cases_updated++;
      }
      q.insEvent.run(contact.id, kase.id, importId, chargeDate, amount, reason, reasonCode, reference,
        str(get(row, 'bank')), str(get(row, 'branch')), maskSensitive(str(get(row, 'account'))), JSON.stringify(raw), dedupKey,
        source ? source.id : null, chargeItem, payMethod, methodStatus, expiry);
      const t = touchedCases.get(kase.id); t.added++; t.amount += amount;
      stats.rows_imported++;
      stats.total_amount += amount;
    });

    for (const [caseId, t] of touchedCases) {
      const what = isReturns ? 'חיובים שחזרו' : 'רשומות אמצעי תשלום';
      const txt = t.created
        ? `תיק נפתח בייבוא "${filename}"${source ? ` (${source.name})` : ''} – ${t.added} ${what}${isReturns ? `, סה"כ ₪${t.amount.toFixed(2)}` : ''}`
        : `נוספו ${t.added} ${what} מייבוא "${filename}"${isReturns ? ` (₪${t.amount.toFixed(2)})` : ''}`;
      q.insAction.run(caseId, userId, 'import', txt, ts);
      q.touchCase.run(ts, caseId);
    }
    q.updImport.run(stats.rows_total, stats.rows_imported, stats.rows_duplicate, stats.rows_error, stats.cases_created, stats.cases_updated,
      stats.contacts_created, Math.round(stats.total_amount * 100) / 100, JSON.stringify(errors.slice(0, 500)), importId);
    return { importId, touched: touchedCases };
  });

  const { importId, touched } = tx();
  if (source) {
    const named = {};
    for (const [f, c] of Object.entries(mapping)) if (c !== '' && c != null && headers[+c]) named[f] = headers[+c];
    db.prepare('UPDATE sources SET mapping_json = ? WHERE id = ?').run(JSON.stringify(named), source.id);
  }
  stats.newCaseIds = [...touched].filter(([, t]) => t.created).map(([id]) => id);
  const prevSameFile = db.prepare('SELECT COUNT(*) n FROM imports WHERE file_hash = ? AND id <> ?').get(fileHash, importId).n;
  return { importId, ...stats, total_amount: Math.round(stats.total_amount * 100) / 100, duplicate_amount: Math.round(stats.duplicate_amount * 100) / 100, errors: errors.slice(0, 100), sameFileImportedBefore: prevSameFile > 0 };
}

module.exports = { analyze, runImport, FIELDS, guessMapping, toIsoDate, toAmount, maskSensitive };
