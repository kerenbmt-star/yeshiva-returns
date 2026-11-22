// מנוע ההודעות הקוליות: נוסחים הניתנים לעריכה, איחוד הוראות קבע לאותו אדם, תפריט טלפוני לכל מוסד, ותיעוד.
const { db, getSetting, now, today } = require('./db');

// ---------- נוסחי ברירת מחדל (כולם ניתנים לעריכה בהגדרות) ----------
const DEFAULTS = {
  msg_single: 'שלום וברכה [שם]. לידיעתך, הוראת הקבע שלך ל[מוסד] לא כובדה, והתשלום על סך [סכום] עבור [סעיף] לא הושלם. סיבת ההחזרה: [סיבה]. נשמח שתסדיר את התשלום בהקדם. תודה רבה.',
  msg_multi: 'שלום וברכה [שם]. לידיעתך, קיימות במערכת [מספר] הוראות קבע שהתשלום עבורן לא הושלם, בסך כולל של [סכום]. ואלה הפרטים: [פירוט] נשמח שתסדיר את התשלום בהקדם. תודה רבה.',
  msg_reminder: 'שלום וברכה [שם]. זוהי תזכורת: התשלום עבור הוראת הקבע שלך ל[מוסד] עדיין לא הושלם. נשמח שתסדיר את התשלום בהקדם. תודה רבה.',
  msg_reminder_multi: 'שלום וברכה [שם]. זוהי תזכורת: קיימות במערכת [מספר] הוראות קבע שהתשלום עבורן עדיין לא הושלם. ואלה הפרטים: [פירוט] נשמח שתסדיר את התשלום בהקדם. תודה רבה.',
  msg_no_method: 'שלום וברכה [שם]. במערכת שלנו לא מוגדר עבורך כרגע אמצעי תשלום פעיל. נשמח שתסדיר אמצעי תשלום בהקדם כדי שנוכל להמשיך את הגבייה בצורה מסודרת. תודה רבה.',
  msg_expiry: 'שלום וברכה [שם]. לידיעתך, תוקף אמצעי התשלום של הוראת הקבע עבור [סעיף] מסתיים ב[תוקף]. נשמח שתעדכן אמצעי תשלום חדש בהקדם, כדי שהגבייה תימשך כסדרה. תודה רבה.',
  msg_expiry_multi: 'שלום וברכה [שם]. לידיעתך, תוקף אמצעי התשלום עומד להסתיים בכמה הוראות קבע: [פירוט] נשמח שתעדכן אמצעי תשלום חדש בהקדם, כדי שהגבייה תימשך כסדרה. תודה רבה.',
  msg_combined_intro: 'שלום וברכה [שם]. להלן כמה הודעות מ[מוסד].',
  line_return: 'סעיף [סעיף], [סכום], סיבה: [סיבה].',
  line_expiry: 'עבור [סעיף], בתוקף עד [תוקף].',
  combined_item: 'הודעה [מספר], [נושא]:',
  combined_title_returns: 'לגבי חזרת הוראת קבע',
  combined_title_expiry: 'לגבי תוקף אמצעי התשלום',
  combined_title_no_method: 'לגבי אמצעי תשלום',
  combined_end: 'תודה רבה.',
  ivr_unknown_greeting: 'שלום וברכה, הגעתם למערכת הגבייה של מוסדות נתיבות שלום סלונים.',
  ivr_invalid: 'בחירה לא תקינה.',
  ivr_record_prompt: 'אנא השאירו הודעה לאחר הצליל. בסיום הקישו סולמית.',
  ivr_record_saved: 'ההודעה נשמרה. תודה רבה ותזכו למצוות.',
  ivr_message_option: 'להשארת הודעה הקישו [הקשה].',
  ivr_message_digit: '1',
};
// הגדרות ברירת מחדל לכל מוסד (סוג קובץ)
const SOURCE_DEFAULTS = {
  institution: '',            // שם המוסד שיוקרא, למשל "ישיבת נתיבות שלום סלונים"
  office_phone: '',           // לאן מנתבים
  office_digit: '2',
  office_option: 'למשרדי [מוסד] הקישו [הקשה].',
  transfer_text: 'מעביר אותך למשרדי [מוסד].',
  allow_record: true,
  greeting: '',               // פתיח אישי למוסד (לפני ההודעה). ריק = ללא
  main_digit: '',             // הקשה בתפריט הראשי למתקשר לא מזוהה
  main_option: 'לענייני [מוסד] הקישו [הקשה].',
  msg_single: '', msg_multi: '',
  closing_text: null,         // משפט לפני "תודה רבה" בהודעות החזרה. null = אוטומטי (בתרומות: המשך תמיכה באמצעי תשלום אחר)
  routing_rules: [],          // ניתוב לפי שעות: [{label, phone, days:'0,1,2,3,4', from:'09:00', to:'13:00'}]
  reminders_enabled: false, reminder_days: 5, reminder_max: 2, reminder_base: 'manual', reminder_texts: [],
};

const OLD_DEFAULTS = {
  msg_expiry: 'שלום וברכה [שם]. לידיעתך, תוקף אמצעי התשלום שלך מסתיים ב[תוקף]. נשמח שתעדכן אמצעי תשלום חדש בהקדם, כדי שהגבייה תימשך כסדרה. תודה רבה.',
  msg_single: 'שלום וברכה [שם]. לידיעתך, הוראת הקבע שלך ל[מוסד] לא כובדה, והתשלום על סך [סכום] עבור [סעיף] לא הושלם. נשמח שתסדיר את התשלום בהקדם. תודה רבה.',
  msg_multi: 'שלום וברכה [שם]. לידיעתך, קיימות במערכת [מספר] הוראות קבע שהתשלום עבורן לא הושלם, בסך כולל של [סכום]. נשמח שתסדיר את התשלום בהקדם. תודה רבה.',
  msg_reminder_multi: 'שלום וברכה [שם]. זוהי תזכורת: קיימות במערכת [מספר] הוראות קבע שהתשלום עבורן עדיין לא הושלם. נשמח שתסדיר את התשלום בהקדם. תודה רבה.',
};
const setting = (k) => { const v = getSetting(k); return v != null && v !== '' && v !== OLD_DEFAULTS[k] ? v : DEFAULTS[k]; };
function sourceConfig(src) {
  let c = {};
  if (!src) src = {};
  try { c = src.config_json ? JSON.parse(src.config_json) : {}; } catch (_) { c = {}; }
  const cfg = { ...SOURCE_DEFAULTS, ...c };
  if (!cfg.institution) cfg.institution = getSetting('org_name') || 'הישיבה';
  if (!cfg.office_phone) cfg.office_phone = getSetting('office_phone') || '';
  return cfg;
}
const sourceById = (id) => (id ? db.prepare('SELECT * FROM sources WHERE id = ?').get(id) : null);

const COUNT_WORDS = { 1: 'הוראת קבע אחת', 2: 'שתי', 3: 'שלוש', 4: 'ארבע', 5: 'חמש', 6: 'שש', 7: 'שבע', 8: 'שמונה', 9: 'תשע', 10: 'עשר' };
const countWord = (n) => COUNT_WORDS[n] || String(n);
function fill(tpl, vars) {
  let t = String(tpl || '');
  if (!vars.amount) t = t.replace(/[,\s]*(על סך|בסך כולל של|בסך|של)\s*\[סכום\]/g, '');
  if (!vars.items) t = t.replace(/[,\s]*עבור\s*\[סעיף\]/g, '');
  if (!vars.reason) t = t.replace(/[,.\s]*סיבת ההחזרה:?\s*\[סיבה\]\.?/g, '.').replace(/[,\s]*סיבה:?\s*\[סיבה\]/g, '').replace(/\[סיבה\]/g, '');
  return t.replace(/\[שם\]/g, vars.name || '').replace(/\[סכום\]/g, vars.amount || '').replace(/\[סעיף\]/g, vars.items || '')
    .replace(/\[מספר\]/g, vars.count || '').replace(/\[מוסד\]/g, vars.institution || '').replace(/\[תוקף\]/g, vars.expiry || '')
    .replace(/\[הקשה\]/g, vars.digit || '').replace(/\[פירוט\]/g, vars.detail || '').replace(/\[סיבה\]/g, vars.reason || '').replace(/\[נושא\]/g, vars.topic || '').replace(/\s+/g, ' ').replace(/\s+([.,])/g, '$1').replace(/\.\.+/g, '.').trim();
}
// מפרק לקטעים (משפטים) – בין קטע לקטע יש הפסקה בהקראה
const toParts = (text) => String(text || '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);

// ---------- איסוף ההוראות הפתוחות של אדם ----------
function openEvents(contactId, { caseIds = null, eventIds = null, scopeSql = '1=1', scopeParams = [] } = {}) {
  let sql = `SELECT e.*, c.source_id case_source, c.assigned_user_id, s.kind source_kind FROM return_events e JOIN cases c ON c.id = e.case_id LEFT JOIN sources s ON s.id = c.source_id
    WHERE c.contact_id = ? AND e.status = 'open' AND c.status IN ('new','in_progress','waiting') AND ${scopeSql}`;
  const params = [contactId, ...scopeParams];
  if (caseIds && caseIds.length) { sql += ` AND c.id IN (${caseIds.map(() => '?').join(',')})`; params.push(...caseIds); }
  if (eventIds && eventIds.length) { sql += ` AND e.id IN (${eventIds.map(() => '?').join(',')})`; params.push(...eventIds); }
  return db.prepare(sql + ' ORDER BY e.id').all(...params);
}

// תוקף להקראה: "12/26" -> "דצמבר 2026"
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
function spokenExpiry(v) {
  const t = String(v || '').trim(); if (!t) return '';
  let m = t.match(/^(\d{1,2})\s*[\/\-.]\s*(\d{2,4})$/); if (m && +m[1] >= 1 && +m[1] <= 12) return `${HE_MONTHS[+m[1] - 1]} ${+m[2] < 100 ? 2000 + +m[2] : +m[2]}`;
  m = t.match(/^(\d{4})-(\d{2})/); if (m && +m[2] >= 1 && +m[2] <= 12) return `${HE_MONTHS[+m[2] - 1]} ${m[1]}`;
  return t;
}
// סיבת החזרה להקראה: בלי קודים ומספרים בלבד
const cleanReason = (r) => { const t = String(r || '').replace(/^\s*\d+\s*[-–:.]?\s*/, '').trim(); return /[א-ת]/.test(t) ? t.slice(0, 60) : ''; };
// מפרק משפטים לקטעים: חלקים קבועים (זהים בכל השיחות) וחלקים משתנים (שם, סכום, סעיף, סיבה...).
// כל קטע נשלח לימות בנפרד; קטע שכבר הוקרא פעם נשמר אצלם ומתחיל מיד.
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function cacheSegments(parts, variables) {
  // מעט חלקים וגדולים (פחות הפסקות): חלק 1 = "שלום וברכה" + השם; אחר כך חותכים רק סביב סכומים –
  // כל השאר נשאר משפט רציף (רובו קבוע לכל מוסד ולכן נשמר אצל ימות אחרי הפעם הראשונה)
  const name = String(variables[0] || '').trim();
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  let head = '', rest = text;
  const ni = name ? text.indexOf(name) : -1;
  if (ni >= 0 && ni < 40) { head = text.slice(0, ni + name.length).replace(/[\s,.:;]+$/, ''); rest = text.slice(ni + name.length); }
  const out = [];
  const push = (t) => { t = String(t).replace(/^[\s,.:;–-]+|[\s,:;–-]+$/g, '').trim(); if (t && /[א-ת0-9]/.test(t)) out.push(t); };
  push(head);
  // הפסקה קטנה בין הודעה להודעה ולפני "תודה רבה" (גבול בין חלקים = הפסקה קצרה בהקראה)
  for (const chunk of rest.split(/(?=הודעה (?:שנייה|שלישית|רביעית)[,:])|(?=תודה רבה)/)) {
    const re = /\d[\d,]*\s*שקלים/g; let last = 0; let m;
    while ((m = re.exec(chunk))) { push(chunk.slice(last, m.index)); push(m[0]); last = m.index + m[0].length; }
    push(chunk.slice(last));
  }
  return out.length ? out : parts;
}
// ---------- בניית ההודעה ----------
// trigger: manual / auto_reminder / monthly_no_method / expiry / inbound
function buildMessage(contactId, { caseIds = null, eventIds = null, trigger = 'manual', reminderNo = null, expiry = null, events = null, name = null } = {}) {
  // events/name – לשיחות חימום: הודעת דוגמה שבנויה בדיוק כמו הודעה אמיתית, בלי תיקים אמיתיים
  const ct = name ? { full_name: name } : db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!ct) return null;
  const all = events || openEvents(contactId, { caseIds, eventIds });
  // שלושה סוגי הודעות: החזרת הוראת קבע · תוקף אמצעי תשלום · אין אמצעי תשלום
  const groups = {
    returns: all.filter((e) => e.source_kind !== 'payment_methods'),
    expiry: all.filter((e) => e.source_kind === 'payment_methods' && e.expiry),
    no_method: all.filter((e) => e.source_kind === 'payment_methods' && !e.expiry),
  };
  const fallbackSrc = sourceById(caseIds && caseIds.length ? (db.prepare('SELECT source_id FROM cases WHERE id = ?').get(caseIds[0]) || {}).source_id : null);

  // בונה את הנוסח לסוג אחד של הודעה
  const render = (evs, kind) => {
    const sourceIds = [...new Set(evs.map((e) => e.case_source).filter(Boolean))];
    const src = sourceById(sourceIds[0]) || fallbackSrc;
    const cfg = sourceConfig(src);
    const total = evs.reduce((a, e) => a + (e.amount || 0), 0);
    const items = [...new Set(evs.map((e) => e.charge_item).filter(Boolean))].join(' ו');
    const institutions = [...new Set(sourceIds.map((id) => sourceConfig(sourceById(id)).institution))].join(' ו') || cfg.institution;
    const n = evs.length;
    const bySrc = new Map();
    for (const e of evs) { const k = e.case_source || 0; if (!bySrc.has(k)) bySrc.set(k, []); bySrc.get(k).push(e); }
    const detail = [...bySrc.entries()].map(([sid, list]) => {
      const inst = sourceConfig(sourceById(sid)).institution;
      const byItem = new Map();
      for (const e of list) { const k = e.charge_item || 'הוראת קבע'; byItem.set(k, (byItem.get(k) || 0) + (e.amount || 0)); }
      const reasons = new Map();
      for (const e of list) { const k = e.charge_item || 'הוראת קבע'; const r = cleanReason(e.reason); if (r && !reasons.has(k)) reasons.set(k, r); }
      const lines = [...byItem.entries()].map(([it, sum]) => fill(setting('line_return'), { items: it, amount: `${Math.round(sum)} שקלים`, reason: reasons.get(it) || '' })).join(' ');
      return bySrc.size > 1 ? `ל${inst}: ${lines}` : lines;
    }).join(' ');
    const reason = [...new Set(evs.map((e) => cleanReason(e.reason)).filter(Boolean))].join(' ו');
    const exp = kind === 'expiry' ? (expiry || evs.map((e) => e.expiry).find(Boolean)) : expiry;
    const vars = { reason, detail, name: ct.full_name, amount: total ? `${Math.round(total)} שקלים` : '', items, count: countWord(n), institution: institutions, expiry: spokenExpiry(exp) };
    let tpl;
    if (kind === 'expiry') {
      // תוקף: לכל הוראה – הסעיף שלה והתאריך שלה
      const byExp = new Map();
      for (const e of evs) { const k = spokenExpiry(e.expiry || expiry) || ''; if (!byExp.has(k)) byExp.set(k, []); if (e.charge_item) byExp.get(k).push(e.charge_item); }
      if (byExp.size > 1) {
        vars.detail = [...byExp.entries()].map(([d, its]) => fill(setting('line_expiry'), { items: its.length ? [...new Set(its)].join(' ו') : 'הוראת קבע', expiry: d })).join(' ');
        tpl = setting('msg_expiry_multi');
      } else tpl = setting('msg_expiry');
    }
    else if (kind === 'no_method') tpl = setting('msg_no_method');
    else if (trigger === 'auto_reminder') {
      const texts = Array.isArray(cfg.reminder_texts) ? cfg.reminder_texts : [];
      tpl = (reminderNo && texts[reminderNo - 1]) || (n > 1 ? setting('msg_reminder_multi') : setting('msg_reminder'));
    } else tpl = n > 1 ? (cfg.msg_multi || setting('msg_multi')) : (cfg.msg_single || setting('msg_single'));
    let text = fill(tpl, vars);
    if (kind === 'returns' && trigger !== 'auto_reminder') {
      // משפט הבקשה של המוסד – במקום "נשמח שתסדיר את התשלום בהקדם" (בתרומות: המשך השתתפות בעדכון אמצעי תשלום)
      const closing = cfg.closing_text != null ? String(cfg.closing_text).trim() : (/תרומ/.test((src && src.name) || '') ? 'נשמח מאוד שתמשיך לקחת חלק בהחזקת המוסדות על ידי עדכון אמצעי תשלום.' : '');
      if (closing) {
        const c2 = closing.replace(/[.\s]*$/, '.');
        if (/נשמח שתסדיר את התשלום בהקדם\.?/.test(text)) text = text.replace(/נשמח שתסדיר את התשלום בהקדם\.?/, c2);
        else text = /תודה רבה/.test(text) ? text.replace(/תודה רבה/, `${c2} תודה רבה`) : `${text} ${c2}`;
      }
    }
    return { text, cfg, vars, sourceIds, src };
  };
  // גוף ההודעה בלי "שלום וברכה [שם]" בהתחלה ובלי "תודה רבה" בסוף – לשימוש בהודעה משולבת
  const body = (t) => String(t).replace(/^\s*שלום וברכה[^.]*\.\s*/, '').replace(/^לידיעתך,?\s*/, '').replace(/\s*תודה רבה\.?\s*$/, '').trim();

  let kinds;
  if (trigger === 'monthly_no_method') kinds = ['no_method'];
  else if (trigger === 'expiry') kinds = ['expiry'];
  else kinds = ['returns', 'expiry', 'no_method'].filter((k) => groups[k].length);
  const used = kinds.flatMap((k) => (k === 'returns' || groups[k].length ? groups[k] : []));
  const parts = [];
  let sourceIds = [];
  if (kinds.length <= 1) {
    const kind = kinds[0] || (trigger === 'expiry' ? 'expiry' : 'returns');
    const r = render(groups[kind] || [], kind);
    if (r.cfg.greeting) parts.push(...toParts(fill(r.cfg.greeting, r.vars)));
    parts.push(...toParts(r.text));
    sourceIds = r.sourceIds.length ? r.sourceIds : (r.src ? [r.src.id] : []);
  } else {
    // כמה סוגי הודעות לאותו אדם: פתיחה אחת, ואז כל הודעה ממוספרת
    const TITLES = { returns: setting('combined_title_returns'), expiry: setting('combined_title_expiry'), no_method: setting('combined_title_no_method') };
    const ORD = ['ראשונה', 'שנייה', 'שלישית'];
    const rs = kinds.map((k) => ({ k, r: render(groups[k], k) }));
    const inst = (rs[0] && rs[0].r.sourceIds.length ? sourceConfig(sourceById(rs[0].r.sourceIds[0])).institution : sourceConfig(fallbackSrc).institution);
    parts.push(...toParts(fill(setting('msg_combined_intro'), { name: ct.full_name, institution: inst, count: String(kinds.length) })));
    rs.forEach(({ k, r }, i) => parts.push(...toParts(`${fill(setting('combined_item'), { count: ORD[i] || String(i + 1), topic: TITLES[k] })} ${body(r.text)}`)));
    parts.push(...toParts(setting('combined_end')));
    sourceIds = [...new Set(rs.flatMap(({ r }) => r.sourceIds))];
  }
  const total = used.reduce((a, e) => a + (e.amount || 0), 0);
  // חלוקה לקטעים שחוזרים על עצמם (ימות שומרים קטע שכבר הוקרא – ובפעם הבאה הוא מתחיל מיד)
  const variables = [ct.full_name, ...used.map((e) => e.charge_item && 'סעיף ' + e.charge_item), ...used.map((e) => cleanReason(e.reason) && 'סיבה: ' + cleanReason(e.reason)), ...used.map((e) => e.charge_item), ...used.map((e) => cleanReason(e.reason)), ...used.map((e) => spokenExpiry(e.expiry)), spokenExpiry(expiry),
    ...[...new Set(used.map((e) => e.case_source))].map((id) => sourceConfig(sourceById(id)).institution)];
  const segments = cacheSegments(parts, variables);
  return { parts: segments, text: parts.join(' '), eventIds: used.map((e) => e.id), caseIds: [...new Set(used.map((e) => e.case_id))], sourceIds, count: used.length, total, kinds };
}

// ---------- תפריט טלפוני לפי המוסדות שבהודעה ----------
function buildMenu(sourceIds) {
  const msgDigit = String(setting('ivr_message_digit') || '1');
  const opts = [];
  const used = new Set();
  const srcs = (sourceIds && sourceIds.length ? sourceIds : []).map(sourceById).filter(Boolean);
  if (!srcs.length) srcs.push(null);
  const anyRecord = srcs.some((s) => sourceConfig(s).allow_record);
  if (anyRecord) { opts.push({ digit: msgDigit, type: 'record', source_id: srcs[0] ? srcs[0].id : null, text: fill(setting('ivr_message_option'), { digit: msgDigit }) }); used.add(msgDigit); }
  for (const s of srcs) {
    const cfg = sourceConfig(s);
    const target = routingTarget(cfg);
    if (!target.phone) continue;
    let d = String(cfg.office_digit || '2');
    while (used.has(d) && Number(d) < 9) d = String(Number(d) + 1);
    used.add(d);
    opts.push({ digit: d, type: 'transfer', source_id: s ? s.id : null, phone: target.phone, to_label: target.label,
      text: fill(cfg.office_option, { digit: d, institution: cfg.institution }),
      transfer: target.label ? `מעביר אותך ל${target.label}.` : fill(cfg.transfer_text, { institution: cfg.institution }) });
  }
  return opts;
}
// ניתוב לפי ימים ושעות: הכלל הראשון שמתאים לרגע הזה, אחרת טלפון המשרד
function routingTarget(cfg, d = new Date()) {
  const hm = (t) => { const [h, m] = String(t || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const nowM = d.getHours() * 60 + d.getMinutes();
  for (const r of (Array.isArray(cfg.routing_rules) ? cfg.routing_rules : [])) {
    if (!r || !r.phone) continue;
    const days = String(r.days || '0,1,2,3,4').split(',').map(Number);
    if (!days.includes(d.getDay())) continue;
    const from = hm(r.from || '00:00'), to = hm(r.to || '23:59');
    if (nowM >= from && nowM < to) return { phone: String(r.phone).replace(/\D/g, ''), label: r.label || '' };
  }
  return { phone: String(cfg.office_phone || '').replace(/\D/g, ''), label: '' };
}
// תפריט ראשי למתקשר שאין לו תיק: בחירת מוסד
function mainMenu() {
  return db.prepare('SELECT * FROM sources WHERE active = 1 ORDER BY id').all().map((s) => ({ s, cfg: sourceConfig(s) }))
    .filter((x) => x.cfg.main_digit).map((x) => ({ digit: String(x.cfg.main_digit), source_id: x.s.id, text: fill(x.cfg.main_option, { digit: x.cfg.main_digit, institution: x.cfg.institution }) }));
}

// ---------- הכנסת הודעה לתור ----------
function phoneOf(ct) {
  const bad = (ct.bad_phones || '').split(',');
  return [ct.phone1, ct.phone2, ct.phone3].find((p) => p && !bad.includes(p)) || null;
}
// מחזיר {id} או {skipped: סיבה}
function queueMessage(contactId, { waitFor = null, caseIds = null, eventIds = null, trigger = 'manual', reminderNo = null, userId = null, expiry = null, phone = null, scheduledFor = null } = {}) {
  const ct = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!ct) return { skipped: 'not_found' };
  const ph = phone || phoneOf(ct);
  if (!ph) return { skipped: 'no_phone' };
  // מניעת כפילות: כבר יש הודעה שממתינה / בשליחה לאותו אדם
  if (db.prepare("SELECT 1 FROM voice_calls WHERE contact_id = ? AND status IN ('queued','sending') ").get(contactId)) return { skipped: 'already_queued' };
  const m = buildMessage(contactId, { caseIds, eventIds, trigger, reminderNo, expiry });
  if (!m) return { skipped: 'not_found' };
  if (!m.caseIds.length && !['monthly_no_method', 'expiry'].includes(trigger)) return { skipped: 'nothing_open' };
  let primary = m.caseIds[0] || (caseIds && caseIds[0]);
  if (!primary) { const c = db.prepare('SELECT id FROM cases WHERE contact_id = ? ORDER BY id DESC LIMIT 1').get(contactId); primary = c && c.id; }
  if (!primary) return { skipped: 'no_case' };
  const ts = now();
  const id = db.prepare(`INSERT INTO voice_calls (case_id, contact_id, phone, message_text, parts_json, event_ids, case_ids, trigger, reminder_no, status, created_by, created_at, updated_at, scheduled_for, wait_for)
    VALUES (?,?,?,?,?,?,?,?,?, 'queued', ?, ?, ?, ?, ?)`).run(primary, contactId, ph, m.text, JSON.stringify(m.parts), JSON.stringify(m.eventIds), JSON.stringify(m.caseIds.length ? m.caseIds : [primary]),
    trigger, reminderNo, userId, ts, ts, scheduledFor, waitFor || null).lastInsertRowid;
  const label = { manual: 'הודעה קולית ידנית', auto_reminder: `תזכורת אוטומטית מס' ${reminderNo}`, monthly_no_method: 'הודעה חודשית – אין אמצעי תשלום', expiry: 'התראה על תוקף אמצעי תשלום', inbound: 'שיחה נכנסת' }[trigger] || trigger;
  for (const cid of (m.caseIds.length ? m.caseIds : [primary])) {
    db.prepare('INSERT INTO actions (case_id, user_id, type, text, created_at) VALUES (?,?,?,?,?)').run(cid, userId, 'auto_call',
      `${label} נכנסה לשליחה ל-${ph}${m.count > 1 ? ` (הודעה מאוחדת על ${m.count} הוראות קבע)` : ''}`, ts);
  }
  return { id, count: m.count };
}

// שליחה ידנית: מקבל רשימת תיקים ומחליט לפי ההגדרה – הודעה מאוחדת לאדם או הודעה לכל תיק
function queueManual(caseIds, userId) {
  const mode = getSetting('send_mode') || 'unified';
  const rows = caseIds.map((id) => db.prepare('SELECT id, contact_id, status FROM cases WHERE id = ?').get(id)).filter(Boolean);
  const res = { queued: 0, skipped: 0, noPhone: 0, closed: 0 };
  const open = rows.filter((r) => ['new', 'in_progress', 'waiting'].includes(r.status));
  res.closed = rows.length - open.length;
  const groups = mode === 'unified' ? [...new Map(open.map((r) => [r.contact_id, open.filter((x) => x.contact_id === r.contact_id).map((x) => x.id)])).entries()] : open.map((r) => [r.contact_id, [r.id]]);
  for (const [contactId, ids] of groups) {
    const r = queueMessage(contactId, { caseIds: ids, trigger: 'manual', userId });
    if (r.id) res.queued++; else if (r.skipped === 'no_phone') res.noPhone++; else res.skipped++;
  }
  return res;
}


// ---------- שיחות חימום: הודעת דוגמה לכל סוג, כדי שימות ישמרו מראש את החלקים הקבועים ----------
function warmupSamples(name) {
  const top = (sid, col) => (db.prepare(`SELECT ${col} v, COUNT(*) n FROM return_events e JOIN cases c ON c.id = e.case_id WHERE c.source_id = ? AND ${col} IS NOT NULL AND ${col} <> '' GROUP BY ${col} ORDER BY n DESC LIMIT 2`).all(sid) || []).map((r) => r.v);
  const returns = db.prepare("SELECT * FROM sources WHERE active = 1 AND kind = 'returns' ORDER BY id").all();
  const pm = db.prepare("SELECT * FROM sources WHERE active = 1 AND kind = 'payment_methods' ORDER BY id LIMIT 1").get();
  let n = 0;
  const ev = (src, extra) => ({ id: --n, case_id: 0, case_source: src.id, source_kind: src.kind, amount: 100, charge_item: null, reason: null, expiry: null, ...extra });
  const out = [];
  const add = (label, events, opts = {}) => { const m = buildMessage(null, { events, name, ...opts }); if (m && m.parts.length) out.push({ label, ...m }); };
  for (const s of returns) {
    const items = top(s.id, 'charge_item'); const reasons = top(s.id, 'reason');
    const e1 = ev(s, { charge_item: items[0] || null, reason: reasons[0] || null });
    add(`${s.name}: הוראה אחת`, [e1]);
    add(`${s.name}: כמה הוראות`, [e1, ev(s, { amount: 50, charge_item: items[1] || items[0] || null, reason: reasons[1] || reasons[0] || null })]);
    if (sourceConfig(s).reminders_enabled) add(`${s.name}: תזכורת`, [e1], { trigger: 'auto_reminder', reminderNo: 1 });
    if (pm) add(`${s.name}: כמה סוגי הודעות`, [e1, ev(pm, { amount: 0, expiry: '12/26' }), ev(pm, { amount: 0 })]);
  }
  if (pm) { add('תוקף אמצעי תשלום', [ev(pm, { amount: 0, expiry: '12/26' })]); add('אין אמצעי תשלום', [ev(pm, { amount: 0 })]); }
  return out;
}
module.exports = { warmupSamples, routingTarget, DEFAULTS, SOURCE_DEFAULTS, setting, sourceConfig, buildMessage, buildMenu, mainMenu, queueMessage, queueManual, openEvents, fill, toParts, phoneOf };
