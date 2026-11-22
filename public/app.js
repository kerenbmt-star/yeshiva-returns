'use strict';
// ממשק המערכת – JavaScript נקי ללא תלויות

const STATUSES = { new: 'חדש', in_progress: 'בטיפול', waiting: 'ממתין לחודש הבא', resolved: 'טופל', unresolvable: 'לא ניתן לטיפול' };
const ACTION_TYPES = { note: 'הערה', call: 'שיחת טלפון', call_no_answer: 'ניסיון שיחה – אין מענה', payment_promise: 'התחייבות לתשלום', payment: 'תשלום התקבל', email: 'מייל', sms: 'הודעה', meeting: 'פגישה' };
const SYS_TYPES = { status: 'שינוי סטטוס', assign: 'שיוך', followup: 'מעקב', import: 'ייבוא', contact: 'פרטי קשר', auto_call: 'שיחה אוטומטית', delete: 'מחיקה' };

const state = { me: null, orgName: 'ישיבת סלונים', users: [], sources: [], view: 'active', q: '', assignee: '', source: '', stats: null, selected: new Set() };
const OUTCOMES = { no_answer: 'לא ענה', callback: 'ביקש לחזור אליו', promised: 'התחייב לשלם', updated_method: 'עדכן אמצעי תשלום', paid: 'שילם', cancel_request: 'מבקש לבטל', wrong_number: 'מספר שגוי' };
const KIND = { returns: 'החזרות חיובים', payment_methods: 'מעקב אמצעי תשלום' };
async function loadSources() { state.sources = await api('GET', '/api/sources'); }
const srcLabel = (r) => [r.source_name, r.charge_items].filter(Boolean).join(' · ');
const $app = document.getElementById('app');

// ---------- כלים ----------
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const money = (n) => '₪' + Number(n || 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// תאריך עברי (יום וחודש באותיות) – מוצג ליד כל תאריך
const GEM = (n) => { const o = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'], t = ['', 'י', 'כ', 'ל']; if (n === 15) return 'ט״ו'; if (n === 16) return 'ט״ז'; const s = t[Math.floor(n / 10)] + o[n % 10]; return s.length > 1 ? s.slice(0, -1) + '״' + s.slice(-1) : s + '׳'; };
let heFmt = null;
const ACCENTS = { blue: ['#1d4e89', '#163d6c', '#e8f0fa'], navy: ['#13294b', '#0c1d36', '#e9edf5'], teal: ['#0e7490', '#0b5e74', '#e0f2fe'], green: ['#2f6b4f', '#24543e', '#e3efe6'], purple: ['#5b21b6', '#4c1d95', '#efe9fb'], brown: ['#7a5230', '#5f3f24', '#f3ebe2'] };
function applyAccent(k) { const a = ACCENTS[k]; const r = document.documentElement.style; if (!a) { ['--primary', '--primary-hover', '--primary-soft'].forEach((v) => r.removeProperty(v)); return; } r.setProperty('--primary', a[0]); r.setProperty('--primary-hover', a[1]); r.setProperty('--primary-soft', a[2]); }
function hebShort(y, mo, d) {
  if (state.prefs && state.prefs.hebDates === false) return '';
  try {
    heFmt = heFmt || new Intl.DateTimeFormat('he-u-ca-hebrew', { day: 'numeric', month: 'long' });
    const p = heFmt.formatToParts(new Date(+y, +mo - 1, +d, 12));
    const day = +(p.find((x) => x.type === 'day') || {}).value; const month = (p.find((x) => x.type === 'month') || {}).value;
    return day && month ? `${GEM(day)} ${month}` : '';
  } catch (_) { return ''; }
}
function fdate(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return esc(s);
  const he = hebShort(m[1], m[2], m[3]);
  return `${m[3]}/${m[2]}/${m[1]}` + (m[4] ? ` ${m[4]}:${m[5]}` : '') + (he ? ` · ${he}` : '');
}
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function nextMonthIso() { const d = new Date(); d.setMonth(d.getMonth() + 1); d.setDate(Math.min(d.getDate(), 28)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const badge = (st) => `<span class="badge st-${esc(st)}">${esc(STATUSES[st] || st)}</span>`;
const isAdmin = () => state.me && state.me.role === 'admin';
const can = (k) => !!(state.me && (state.me.role === 'admin' || (state.me.perms || {})[k]));
const TRIGGER = { manual: 'ידנית', auto_reminder: 'תזכורת אוטומטית', monthly_no_method: 'חודשית – אין אמצעי תשלום', expiry: 'תוקף עומד לפוג', inbound: 'שיחה נכנסת', warmup: 'שיחת חימום' };
const TR_STATUS = { done: 'תומלל', failed: 'התמלול נכשל', pending: 'מתמלל…', none: '' };
const phone = (p) => (p ? `<a class="ltr" href="tel:${esc(p)}" onclick="event.stopPropagation()">${esc(p)}</a>` : '');

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/me')) { state.me = null; route(); throw new Error(data.error || 'נדרשת כניסה'); }
  if (!r.ok) throw new Error(data.error || 'שגיאה');
  return data;
}
let toastTimer;
function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = err ? 'err' : ''; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.style.display = 'none'), 3500);
}
function modal(html, cls = '') {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${cls}" role="dialog">${html}</div>`;
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
  bg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => bg.remove()));
  const f = bg.querySelector('input, select, textarea'); if (f) f.focus();
  return bg;
}
const formData = (el) => Object.fromEntries([...el.querySelectorAll('[name]')].map((i) => [i.name, i.type === 'checkbox' ? i.checked : i.value]));
function userOptions(selected, { includeNone = true, noneLabel = '— ללא מטפל —' } = {}) {
  return (includeNone ? `<option value="">${noneLabel}</option>` : '') +
    state.users.filter((u) => u.active).map((u) => `<option value="${u.id}" ${+selected === u.id ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('');
}
async function loadUsers() { const r = await api('GET', '/api/users'); state.users = r.users; state.unassigned = r.unassigned; if (r.permDefs) state.permDefs = r.permDefs; }

// ---------- מסגרת ----------
function shell(active, content) {
  const nav = [['#/today', 'היום שלי', 'today'], ['#/cases', 'תיקים', 'cases']];
  if (can('admin_dashboard')) nav.push(['#/admin', 'דשבורד מנהל', 'admin']);
  if (can('control')) nav.push(['#/control', 'מסך בקרה', 'control']);
  if (can('people')) nav.push(['#/people', 'אנשי קשר', 'people']);
  if (can('voice')) nav.push(['#/voice', 'הודעות קוליות', 'voice']);
  if (can('workers')) nav.push(['#/workers', 'עובדים', 'workers']);
  if (isAdmin()) nav.push(['#/sources', 'מוסדות וסוגי קבצים', 'sources']);
  if (can('import')) nav.push(['#/import', 'ייבוא', 'import']);
  if (isAdmin()) nav.push(['#/automation', 'תזכורות', 'automation'], ['#/settings', 'הגדרות', 'settings']);
  const icons = state.tabIcons || {};
  const unread = state.stats ? state.stats.unread : 0;
  const blk = state.sendBlock && state.sendBlock.blocked ? `<div class="notice warn" style="margin:0;border-radius:0;text-align:center">🕯️ ${esc(state.sendBlock.reason)} – שיחות לא יוצאות עכשיו. הן מחכות בתור וייצאו אוטומטית אחרי ${esc(state.sendBlock.reason)}, בחלון השליחה הבא.</div>` : '';
  return `${blk}
  <header class="topbar">
    <a class="brand" href="#/" title="לדף הבית" style="color:inherit">${esc(state.orgName)}<small>${state.hebToday ? esc(state.hebToday) + ' · ' : ''}ניהול החזרות הוראות קבע</small></a>
    <nav class="nav">${nav.map(([h, l, k]) => `<a href="${h}" class="${active === k ? 'active' : ''}">${icons[k] ? `<span class="tab-ic">${esc(icons[k])}</span> ` : ''}${l}</a>`).join('')}</nav>
    <div class="user-box">
      <button class="bell" id="bell" title="תזכורות">🔔${unread ? `<span class="dot">${unread}</span>` : ''}</button>
      <span class="small">${esc(state.me.full_name)}${isAdmin() ? ' <span class="muted">(מנהל)</span>' : ''}</span>
      <button class="btn sm" id="changePw">סיסמה</button>
      <button class="btn sm" id="logout">יציאה</button>
    </div>
  </header>
  <main>${content}</main>`;
}
function bindShell() {
  document.getElementById('logout').onclick = async () => { await api('POST', '/api/logout'); state.me = null; location.hash = '#/'; route(); };
  document.getElementById('bell').onclick = showNotifications;
  document.getElementById('changePw').onclick = () => {
    const m = modal(`<h2>שינוי סיסמה</h2><form>
      <div class="notice info">שם המשתמש שלך: <strong class="ltr">${esc(state.me.username || '')}</strong></div>
      ${state.me.canResetPw ? '<p class="small muted">נכנסת עם קוד – אפשר לקבוע סיסמה חדשה בלי הסיסמה הישנה.</p>' : '<div class="field"><label>סיסמה נוכחית</label><input type="password" name="current" required></div>'}
      <div class="field"><label>סיסמה חדשה (8 תווים לפחות)</label><input type="password" name="password" minlength="8" required></div>
      <div class="modal-actions"><button class="btn primary">שמירה</button><button type="button" class="btn" data-close>ביטול</button></div></form>`);
    m.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/me/password', formData(m)); m.remove(); toast('הסיסמה עודכנה'); } catch (err) { toast(err.message, true); }
    };
  };
}

// לאן מוביל כל עדכון בפעמון
function notifLink(n) {
  if (n.case_id) return `#/case/${n.case_id}`;
  if (n.kind === 'voice') return '#/voice';
  if (n.kind === 'import' || n.kind === 'stale' || n.kind === 'nudge' || n.kind === 'morning' || n.kind === 'urgent' || n.kind === 'followup_due') return '#/today';
  if (n.kind === 'dashboard' || n.kind === 'weekly' || n.kind === 'escalation') return can('control') ? '#/control' : '#/today';
  return '';
}
function notifLabel(n) {
  if (n.case_id) return 'לתיק';
  return { '#/voice': 'להודעות הקוליות', '#/today': 'להיום שלי', '#/control': 'למסך הבקרה' }[notifLink(n)] || 'לדף';
}
async function showNotifications() {
  const rows = await api('GET', '/api/notifications');
  const KIND = { followup_due: 'מועד מעקב', stale: 'לא טופל', assigned: 'שיוך', morning: 'בוקר', nudge: 'תזכורת', urgent: 'דחוף', escalation: 'הסלמה', weekly: 'סיכום שבועי', dashboard: 'דשבורד יומי', voice: 'הודעה קולית', import: 'תיקים חדשים', cancel: 'בקשת ביטול' };
  const m = modal(`<h2>תזכורות</h2>
    ${rows.length ? `<ul class="timeline">${rows.map((n) => { const href = notifLink(n); return `<li class="${n.read_at ? 'sys' : ''} ${href ? 'notif-link' : ''}" ${href ? `data-href="${href}"` : ''}>
      <div class="meta">${fdate(n.created_at)}<div class="kind">${esc(KIND[n.kind] || n.kind)}${n.read_at ? '' : ' • חדש'}</div></div>
      <div class="txt">${esc(n.message)} ${href ? `<a href="${href}" data-close>${esc(notifLabel(n))} ←</a>` : ''}</div></li>`; }).join('')}</ul>`
      : '<div class="empty">אין תזכורות</div>'}
    <div class="modal-actions"><button class="btn" data-close>סגירה</button></div>`, 'wide');
  m.querySelectorAll('a[data-close]').forEach((a) => a.addEventListener('click', (e) => { e.stopPropagation(); m.remove(); }));
  m.querySelectorAll('li[data-href]').forEach((li) => li.addEventListener('click', () => { m.remove(); location.hash = li.dataset.href; }));
  // פתיחת החלון = קריאה. מסמנים הכל כנקרא אוטומטית ומורידים את המספר מהפעמון
  const unreadIds = rows.filter((n) => !n.read_at).map((n) => n.id);
  if (unreadIds.length) { api('POST', '/api/notifications/read', { ids: unreadIds }).then(() => { const dot = document.querySelector('#bell .dot'); if (dot) dot.remove(); }).catch(() => {}); }
}

// ---------- כניסה / הגדרה ראשונית ----------
function renderLogin(needsSetup) {
  $app.innerHTML = `<div class="login-wrap"><div class="card login">
    <h1>${esc(state.orgName)}</h1>
    <p class="sub">${needsSetup ? 'הגדרה ראשונית – יצירת חשבון מנהל' : 'ניהול החזרות הוראות קבע – כניסה למערכת'}</p>
    <form id="f">
      ${needsSetup ? `<div class="field"><label>שם מלא</label><input type="text" name="full_name" required></div>
        <div class="field"><label>דוא"ל (לתזכורות)</label><input type="email" name="email"></div>` : ''}
      <div class="field"><label>שם משתמש</label><input type="text" name="username" autocomplete="username" required></div>
      <div class="field"><label>סיסמה${needsSetup ? ' (8 תווים לפחות)' : ''}</label><input type="password" name="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" required></div>
      <button class="btn primary" style="width:100%;justify-content:center">${needsSetup ? 'יצירת מנהל וכניסה' : 'כניסה'}</button>
    </form>
    ${needsSetup ? '' : `<div id="altLogin" hidden>
      <div class="or-line"><span>או</span></div>
      <div id="gBtn" style="display:flex;justify-content:center;margin-bottom:10px"></div>
      <button type="button" class="alt-opt" id="phoneBtn" hidden><span class="ic">📞</span><span><b>כניסה עם קוד בשיחה קולית</b><small>הטלפון מצלצל ומקריא לך קוד – בלי סיסמה</small></span></button>
      <form id="phoneF" class="code-box" hidden>
        <h3>📞 כניסה עם קוד בשיחה קולית</h3>
        <p class="steps" id="phoneSteps">שלב 1 מתוך 2 – כותבים את הטלפון, והמערכת מתקשרת</p>
        <div class="field" id="phoneStep1"><label>מספר הטלפון שלך</label><input type="tel" id="phoneNum" inputmode="tel" autocomplete="tel" placeholder="05X-XXXXXXX" required></div>
        <div id="phoneStep2" hidden><div class="field"><label>הקוד שהוקרא לך בשיחה</label><input type="text" id="phoneCode" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••"></div></div>
        <button class="btn primary" id="phoneGo" style="width:100%;justify-content:center">התקשרו אליי עם קוד</button>
        <button type="button" class="back" id="phoneBack">→ חזרה</button>
      </form>
      <button type="button" class="alt-opt" id="codeBtn" hidden><span class="ic">✉️</span><span><b>כניסה עם קוד למייל</b><small>קוד נשלח למייל שלך – בלי סיסמה</small></span></button>
      <form id="codeF" hidden>
        <div class="field"><label>המייל שלך (כפי שמעודכן במערכת)</label><input type="email" name="email" id="codeEmail" autocomplete="email" required></div>
        <div id="codeStep2" hidden><div class="field"><label>הקוד שקיבלת במייל (6 ספרות)</label><input type="text" name="code" id="codeVal" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div></div>
        <button class="btn primary" id="codeGo" style="width:100%;justify-content:center">שליחת קוד למייל</button>
      </form>
    </div>`}
    </div></div>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', needsSetup ? '/api/setup' : '/api/login', formData(e.target)); await boot(); } catch (err) { toast(err.message, true); }
  };
  if (!needsSetup) setupAltLogin();
}
// כניסה עם גוגל / קוד למייל – מוצגות רק כשהן הוגדרו
async function setupAltLogin() {
  let o; try { o = await api('GET', '/api/login/options'); } catch (_) { return; }
  const box = document.getElementById('altLogin'); if (!box || (!o.email && !o.googleClientId && !o.phone)) return;
  box.hidden = false;
  if (o.phone) {
    const btn = document.getElementById('phoneBtn'), f = document.getElementById('phoneF'), go = document.getElementById('phoneGo');
    btn.hidden = false;
    btn.onclick = () => { btn.hidden = true; f.hidden = false; document.getElementById('phoneNum').focus(); };
    document.getElementById('phoneBack').onclick = () => { f.hidden = true; btn.hidden = false; };
    document.getElementById('phoneCode').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, ''); if (e.target.value.length === 6) f.requestSubmit(); };
    let sent = false;
    f.onsubmit = async (e) => {
      e.preventDefault(); go.disabled = true;
      const phone = document.getElementById('phoneNum').value.trim();
      try {
        if (!sent) {
          await api('POST', '/api/login/phone-code', { phone });
          sent = true; document.getElementById('phoneStep2').hidden = false; document.getElementById('phoneCode').focus();
          document.getElementById('phoneSteps').textContent = 'שלב 2 מתוך 2 – הטלפון יצלצל בעוד רגע. מקלידים את 6 הספרות שהוקראו';
          go.textContent = 'כניסה'; toast('אם המספר רשום במערכת – הטלפון יצלצל בעוד רגע ויוקרא לך קוד.');
        } else { await api('POST', '/api/login/phone-verify', { phone, code: document.getElementById('phoneCode').value }); await boot(); }
      } catch (err) { toast(err.message, true); }
      go.disabled = false;
    };
  }
  if (o.email) {
    const btn = document.getElementById('codeBtn'), f = document.getElementById('codeF'), go = document.getElementById('codeGo');
    btn.hidden = false;
    btn.onclick = () => { btn.hidden = true; f.hidden = false; document.getElementById('codeEmail').focus(); };
    let sent = false;
    f.onsubmit = async (e) => {
      e.preventDefault(); go.disabled = true;
      const email = document.getElementById('codeEmail').value.trim();
      try {
        if (!sent) {
          await api('POST', '/api/login/email-code', { email });
          sent = true; document.getElementById('codeStep2').hidden = false; document.getElementById('codeVal').focus();
          go.textContent = 'כניסה'; toast('אם המייל רשום במערכת – נשלח אליו קוד. הוא בתוקף ל-10 דקות.');
        } else { await api('POST', '/api/login/email-verify', { email, code: document.getElementById('codeVal').value }); await boot(); }
      } catch (err) { toast(err.message, true); }
      go.disabled = false;
    };
  }
  if (o.googleClientId) {
    const init = () => {
      window.google.accounts.id.initialize({ client_id: o.googleClientId, callback: async (r) => {
        try { await api('POST', '/api/login/google', { credential: r.credential }); await boot(); } catch (err) { toast(err.message, true); }
      } });
      window.google.accounts.id.renderButton(document.getElementById('gBtn'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'he', width: 300 });
    };
    if (window.google && window.google.accounts) init();
    else { const sc = document.createElement('script'); sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.onload = init; document.head.appendChild(sc); }
  }
}

// ---------- מסך ראשי ----------
const VIEWS = [['active', 'פעילים'], ['due', 'הגיע מועד מעקב'], ['new', 'חדשים'], ['waiting', 'ממתינים'], ['mine', 'התיקים שלי'], ['closed', 'סגורים'], ['all', 'הכל']];

async function renderDashboard() {
  const [stats] = await Promise.all([api('GET', '/api/stats'), loadUsers(), loadSources()]);
  state.stats = stats;
  $app.innerHTML = shell('cases', `
    <div class="page-head"><div><h1>כל התיקים</h1>
      <p class="sub">${stats.lastImport ? `ייבוא אחרון: ${esc(stats.lastImport.filename)} (${fdate(stats.lastImport.created_at)})` : 'טרם יובאו נתונים'}</p></div>
      <div class="row">${can('add_manual') ? '<button class="btn" id="addManual">הוספת תיק ידנית</button>' : ''}${can('export') ? '<a class="btn" href="/api/export.xlsx">ייצוא ל-Excel</a><a class="btn" href="#/report">🖨️ דוח PDF</a>' : ''}${can('import') ? '<a class="btn primary" href="#/import">ייבוא קובץ חודשי</a>' : ''}</div></div>
    ${!stats.lastImport ? `<div class="notice info">אין עדיין נתונים במערכת. ${isAdmin() ? '<a href="#/import">העלו את קובץ ההחזרות החודשי</a> כדי ליצור תיקים.' : 'מנהל המערכת צריך להעלות את קובץ ההחזרות החודשי.'}</div>` : ''}
    <div class="kpis">
      <div class="kpi" data-view="open"><div class="label">תיקים פתוחים</div><div class="value">${stats.open_cases || 0}</div><div class="hint">${state.unassigned ? `${state.unassigned} ללא מטפל` : '&nbsp;'}</div></div>
      <div class="kpi" data-view="open"><div class="label">סכום החזרות בתיקים פתוחים</div><div class="value">${money(stats.open_amount)}</div><div class="hint">${stats.open_events} חיובים שחזרו</div></div>
      <div class="kpi" data-view="new"><div class="label">תיקים חדשים</div><div class="value">${stats.new_cases || 0}</div><div class="hint">טרם החל טיפול</div></div>
      <div class="kpi" data-view="waiting"><div class="label">ממתינים להמשך טיפול</div><div class="value">${stats.waiting_cases || 0}</div><div class="hint">${stats.due_cases ? `<span class="overdue">${stats.due_cases} הגיע מועד המעקב</span>` : 'ממתין לחודש הבא'}</div></div>
    </div>
    <div class="toolbar">
      <div class="tabs" id="tabs">${VIEWS.map(([k, l]) => `<button data-view="${k}" class="${state.view === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div class="spacer"></div>
      <select id="fSource" class="inline-select"><option value="">כל סוגי הקבצים</option>${state.sources.map((x) => `<option value="${x.id}" ${String(x.id) === state.source ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <select id="fAssignee" class="inline-select"><option value="">כל המטפלים</option><option value="none" ${state.assignee === 'none' ? 'selected' : ''}>ללא מטפל</option>
        ${state.users.map((u) => `<option value="${u.id}" ${String(u.id) === state.assignee ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select>
      <input type="search" class="search" id="q" placeholder="חיפוש: שם, מזהה או טלפון" value="${esc(state.q)}">
    </div>
    <div id="bulk"></div>
    <div class="table-wrap" id="tbl"><div class="empty">טוען…</div></div>`);
  bindShell();
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; state.selected.clear(); renderDashboard(); }));
  document.getElementById('fAssignee').onchange = (e) => { state.assignee = e.target.value; loadTable(); };
  const am = document.getElementById('addManual'); if (am) am.onclick = () => manualDialog();
  document.getElementById('fSource').onchange = (e) => { state.source = e.target.value; loadTable(); };
  let qt; document.getElementById('q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value; loadTable(); }, 250); };
  loadTable();
}

async function loadTable() {
  const params = new URLSearchParams({ view: state.view, q: state.q, assignee: state.assignee, source: state.source });
  const rows = await api('GET', '/api/cases?' + params);
  const t = todayIso();
  const el = document.getElementById('tbl');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="empty">אין תיקים להצגה</div>'; renderBulk(); return; }
  const total = rows.reduce((s, r) => s + r.total_amount, 0);
  el.innerHTML = `<table><thead><tr>
    <th style="width:32px"><input type="checkbox" id="selAll"></th>
    <th>שם מלא</th><th>מזהה איש קשר</th><th>טלפון</th><th class="num">סכום כולל</th><th>סוג / סעיף חיוב</th><th>סיבת החזרה</th><th>סטטוס טיפול</th><th>מטפל אחראי</th><th>טיפול אחרון</th><th>מעקב הבא</th><th>פעולות</th>
  </tr></thead><tbody>
  ${rows.map((r) => `<tr class="clickable" data-id="${r.id}">
    <td onclick="event.stopPropagation()"><input type="checkbox" class="sel" value="${r.id}" ${state.selected.has(r.id) ? 'checked' : ''}></td>
    <td>${can('people') ? `<a href="#/person/${r.contact_id}" onclick="event.stopPropagation()" title="לכרטיס איש הקשר"><strong>${esc(r.full_name || '(ללא שם)')}</strong></a>` : `<strong>${esc(r.full_name || '(ללא שם)')}</strong>`}${r.events_count > 1 ? `<div class="muted small">${r.events_count} חיובים</div>` : ''}</td>
    <td class="nowrap">${esc(r.external_id)}</td>
    <td class="nowrap">${phone(r.phone1 || r.phone2 || r.phone3)}</td>
    <td class="num"><strong>${r.source_kind === 'payment_methods' && !r.total_amount ? '—' : money(r.total_amount)}</strong></td>
    <td><div class="reasons" title="${esc(srcLabel(r))}">${esc(srcLabel(r))}</div></td>
    <td><div class="reasons" title="${esc(r.reasons || r.methods)}">${esc(r.reasons || r.methods || '')}</div></td>
    <td>${badge(r.status)}</td>
    <td class="nowrap">${r.assignee ? esc(r.assignee) : '<span class="muted">—</span>'}</td>
    <td class="nowrap small">${r.last_action_at ? fdate(r.last_action_at.slice(0, 10)) : '<span class="muted">—</span>'}</td>
    <td class="nowrap small ${r.next_followup_date && r.next_followup_date <= t && !['resolved', 'unresolvable'].includes(r.status) ? 'overdue' : ''}">${r.next_followup_date ? fdate(r.next_followup_date) : '<span class="muted">—</span>'}</td>
    <td class="nowrap" onclick="event.stopPropagation()"><button class="btn sm primary" data-call="${r.id}">תיעוד שיחה</button> <button class="btn sm" data-assign="${r.id}" data-cur="${r.assigned_user_id || ''}">שיוך</button></td>
  </tr>`).join('')}</tbody>
  <tfoot><tr><td></td><td colspan="3" class="muted small">${rows.length} תיקים</td><td class="num"><strong>${money(total)}</strong></td><td colspan="7"></td></tr></tfoot></table>`;
  el.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => { location.hash = '#/case/' + tr.dataset.id; }));
  el.querySelectorAll('[data-assign]').forEach((b) => b.addEventListener('click', () => assignDialog([+b.dataset.assign], b.dataset.cur)));
  el.querySelectorAll('[data-call]').forEach((b) => b.addEventListener('click', () => { const r = rows.find((x) => x.id === +b.dataset.call); outcomeDialog(r, loadTable); }));
  el.querySelectorAll('.sel').forEach((c) => c.addEventListener('change', () => { c.checked ? state.selected.add(+c.value) : state.selected.delete(+c.value); renderBulk(); }));
  document.getElementById('selAll').onchange = (e) => { el.querySelectorAll('.sel').forEach((c) => { c.checked = e.target.checked; c.checked ? state.selected.add(+c.value) : state.selected.delete(+c.value); }); renderBulk(); };
  renderBulk();
}
function renderBulk() {
  const el = document.getElementById('bulk');
  if (!el) return;
  el.innerHTML = state.selected.size ? `<div class="notice info row">נבחרו ${state.selected.size} תיקים ${can('assign') ? '<button class="btn sm primary" id="bulkAssign">שיוך התיקים שנבחרו לעובד</button>' : ''} ${can('send_voice') ? '<button class="btn sm primary" id="bulkVoice">שליחת הודעה קולית לנבחרים</button>' : ''} ${can('delete') ? '<button class="btn sm danger" id="bulkDel">מחיקת התיקים שנבחרו</button>' : ''} <button class="btn sm" id="bulkClear">ניקוי בחירה</button></div>` : '';
  if (state.selected.size) {
    const bv = document.getElementById('bulkVoice');
    if (bv) bv.onclick = () => {
      const ids = [...state.selected];
      const m = modal(`<h2>שליחת הודעה קולית ל-${ids.length} תיקים</h2>
        <p>כל אחד ישמע את השם שלו, הסכום והסעיף, ואחר כך את התפריט: 1 השארת הודעה, 2 מעבר למשרדי הישיבה.</p>
        <p class="small muted">עלות משוערת: עד ${ids.length} יחידות (0.1 למי שלא עונה, כיחידה למי שעונה). תיקים סגורים, תיקים בלי טלפון ומי שכבר מחכה לשיחה – ידולגו. השיחות יוצאות בימים א'–ה' 9:00–20:00.</p>
        <div class="modal-actions"><button class="btn primary" id="ok">אישור ושליחה</button><button class="btn" data-close>ביטול</button></div>`);
      m.querySelector('#ok').onclick = async (ev) => {
        ev.target.disabled = true;
        try {
          const g = await warmGate({ case_ids: ids }); if (!g) return;
          const r = await api('POST', '/api/voice/cases', { case_ids: ids, ...g });
          m.remove(); state.selected.clear();
          toast(`${r.queued} הודעות – ${r.window.label}${r.noPhone ? ` · ${r.noPhone} בלי טלפון` : ''}${r.skipped ? ` · ${r.skipped} דולגו` : ''}`);
          loadTable();
        } catch (e) { ev.target.disabled = false; toast(e.message, true); }
      };
    };
    const bd = document.getElementById('bulkDel');
    if (bd) bd.onclick = () => {
      const ids = [...state.selected];
      const m = modal(`<h2>מחיקת ${ids.length} תיקים</h2><p>התיקים שנבחרו יימחקו לגמרי, כולל השורות, השיחות וההיסטוריה שלהם.</p>
        <p class="small muted">אם תייבא שוב את אותו קובץ, מה שנמחק לא ייקלט שוב. נשמר עותק גיבוי של כל מה שנמחק.</p>
        <div class="field"><label>סיבה (לא חובה)</label><input type="text" name="reason" placeholder="למשל: שורת סיכום שנקלטה בטעות"></div>
        <div class="modal-actions"><button class="btn danger" id="ok">מחיקה סופית</button><button class="btn" data-close>ביטול</button></div>`);
      m.querySelector('#ok').onclick = async (ev) => {
        ev.target.disabled = true;
        try { const r = await api('POST', '/api/cases/bulk-delete', { case_ids: ids, ...formData(m) }); m.remove(); state.selected.clear(); toast(`נמחקו ${r.deleted} תיקים`); renderDashboard(); }
        catch (e) { ev.target.disabled = false; toast(e.message, true); }
      };
    };
    const ba = document.getElementById('bulkAssign'); if (ba) ba.onclick = () => assignDialog([...state.selected]);
    document.getElementById('bulkClear').onclick = () => { state.selected.clear(); loadTable(); };
  }
}
function assignDialog(ids, current) {
  const m = modal(`<h2>${ids.length > 1 ? `שיוך ${ids.length} תיקים` : 'שיוך / העברת תיק'}</h2>
    <div class="field"><label>מטפל</label><select name="user_id">${userOptions(current)}</select></div>
    ${ids.length === 1 ? '<div class="field"><label>הערה (לא חובה)</label><input type="text" name="note"></div>' : ''}
    <div class="modal-actions"><button class="btn primary" id="ok">שמירה</button><button class="btn" data-close>ביטול</button></div>`);
  m.querySelector('#ok').onclick = async () => {
    const d = formData(m);
    try {
      if (ids.length === 1) await api('POST', `/api/cases/${ids[0]}/assign`, d);
      else await api('POST', '/api/cases/bulk-assign', { case_ids: ids, user_id: d.user_id });
      m.remove(); state.selected.clear(); toast('השיוך נשמר'); route();
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- כרטיס טיפול ----------
async function renderCase(id) {
  const [d] = await Promise.all([api('GET', `/api/cases/${id}`), loadUsers()]);
  const { case: c, contact: ct, events, actions, assignments, otherCases, calls } = d;
  const closed = ['resolved', 'unresolvable'].includes(c.status);
  let extra = {};
  try { extra = ct.extra_json ? JSON.parse(ct.extra_json) : {}; } catch (_) { /* */ }
  $app.innerHTML = shell('cases', `
    <div class="page-head"><div><a href="#/cases" class="small">→ חזרה לרשימה</a><h1>${esc(ct.full_name || '(ללא שם)')} ${badge(c.status)}</h1>
      <p class="sub"><a href="#/person/${c.contact_id}">כרטיס האדם המלא (כל הסוגים)</a> • ${c.source_name ? `<strong>${esc(c.source_name)}</strong> • ` : ''}תיק מס' ${c.id} • מזהה איש קשר ${esc(ct.external_id)} • נפתח ${fdate(c.created_at)}</p></div>
      ${closed ? '' : '<button class="btn primary" id="logCall">תיעוד שיחה</button>'}</div>
    ${c.status === 'waiting' ? `<div class="notice info">התיק ממתין לחודש הבא. ב-${fdate(c.next_followup_date)} הוא יחזור אוטומטית לרשימת המעקב הפעילה.</div>` : ''}
    <div class="case-layout">
      <div>
        <div class="card">
          <div class="row" style="justify-content:space-between"><h2 style="margin:0">פרטי האדם</h2><button class="btn sm" id="editContact">עריכה</button></div>
          <dl class="info-list" style="margin-top:12px">
            <dt>שם מלא</dt><dd>${esc(ct.full_name)}</dd>
            <dt>מזהה</dt><dd>${esc(ct.external_id)}</dd>
            ${[ct.phone1, ct.phone2, ct.phone3].filter(Boolean).map((p, i) => `<dt>טלפון ${i + 1}</dt><dd>${phone(p)}</dd>`).join('') || '<dt>טלפון</dt><dd class="muted">—</dd>'}
            <dt>כתובת</dt><dd>${esc([ct.address, ct.city].filter(Boolean).join(', ')) || '<span class="muted">—</span>'}</dd>
            ${ct.email ? `<dt>דוא"ל</dt><dd><a class="ltr" href="mailto:${esc(ct.email)}">${esc(ct.email)}</a></dd>` : ''}
            ${Object.entries(extra).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
          </dl>
          ${c.source_kind === 'payment_methods' ? '' : `<div class="total-box"><div class="small muted">סכום כולל לתשלום</div><div class="v">${money(c.total_amount)}</div><div class="small">${events.length} חיובים שחזרו</div></div>`}
        </div>
        <div class="card">
          <h2>טיפול</h2>
          <div class="field"><label>סטטוס</label><div class="row">${badge(c.status)} <button class="btn sm" id="chStatus">שינוי סטטוס</button></div></div>
          <div class="field"><label>מטפל אחראי</label><div class="row"><strong>${esc(c.assignee || '— ללא —')}</strong> <button class="btn sm" id="chAssign">${c.assignee ? 'העברה לעובד אחר' : 'שיוך'}</button></div></div>
          <div class="field"><label>תאריך מעקב הבא</label><div class="row"><input type="date" id="fu" value="${esc(c.next_followup_date || '')}" style="width:auto" ${closed ? 'disabled' : ''}><button class="btn sm" id="saveFu" ${closed ? 'disabled' : ''}>עדכון</button></div></div>
          <div class="field"><label>טיפול אחרון</label><div>${c.last_action_at ? fdate(c.last_action_at) : '<span class="muted">טרם בוצע טיפול</span>'}</div></div>
          <hr style="border:0;border-top:1px solid var(--border)">
          ${can('send_voice') ? `<button class="btn" id="autoCall" ${closed ? 'disabled' : ''}>שליחת הודעה קולית</button>` : ''}
          ${calls.length ? `<div class="small muted" style="margin-top:6px">${calls.map((q) => `${fdate(q.created_at)} – <span class="ltr">${esc(q.phone)}</span> – ${esc(VOICE_ST[q.status] || q.status)}${q.digit_pressed ? ' – הקיש ' + esc(q.digit_pressed) : ''}`).join('<br>')}</div>` : ''}
        </div>
        ${can('delete') ? '<div class="card"><h2>מחיקה</h2><p class="small muted">למחיקת תיק שנוצר בטעות. כל השורות, השיחות וההיסטוריה שלו נמחקות.</p><button class="btn danger" id="delCase">מחיקת התיק כולו</button></div>' : ''}
        ${otherCases.length ? `<div class="card"><h2>תיקים נוספים של אותו אדם</h2>${otherCases.map((o) => `<div class="row small"><a href="#/case/${o.id}">תיק ${o.id}</a> ${badge(o.status)} ${money(o.total)} <span class="muted">${fdate(o.created_at.slice(0, 10))}</span></div>`).join('')}</div>` : ''}
      </div>
      <div>
        <div class="card">
          <div class="row" style="justify-content:space-between"><h2 style="margin:0">${c.source_kind === 'payment_methods' ? 'פרטי אמצעי תשלום' : 'חיובים שחזרו'}</h2><button class="btn sm" id="addEv">הוספת חיוב ידנית</button></div><div style="height:10px"></div>
          <div class="table-wrap"><table><thead><tr><th>תאריך</th><th class="num">סכום</th><th>סעיף חיוב</th><th>סיבת החזרה</th><th>קוד</th>${events.some((e) => e.payment_method || e.method_status || e.expiry) ? '<th>אמצעי תשלום</th><th>מצב</th><th>תוקף</th>' : ''}<th>אסמכתא</th><th>בנק / סניף / חשבון</th><th>מקור</th><th>סטטוס ההוראה</th>${can('delete') ? '<th></th>' : ''}</tr></thead><tbody>
          ${events.map((e) => `<tr><td class="nowrap">${fdate(e.charge_date)}</td><td class="num">${money(e.amount)}</td><td><strong>${esc(e.charge_item || '')}</strong>${can('edit_contacts') ? ` <button class="btn sm" data-evedit="${e.id}" title="עדכון סעיף ומועד פקיעת תוקף">✎</button>` : ''}</td><td>${esc(e.reason)}</td><td>${esc(e.reason_code)}</td>
            ${events.some((x) => x.payment_method || x.method_status || x.expiry) ? `<td>${esc(e.payment_method || '')}</td><td>${esc(e.method_status || '')}</td><td class="nowrap">${esc(e.expiry || '')}</td>` : ''}<td>${esc(e.reference)}</td>
            <td class="nowrap small">${esc([e.bank, e.branch, e.account].filter(Boolean).join(' / '))}</td><td class="small muted">${esc(e.period_label || e.filename || '')}</td>
            <td style="min-width:150px">${e.status === 'resolved' ? `<span class="badge st-resolved">הוסדרה</span>${can('change_status') ? ` <button class="btn sm" data-evst="${e.id}" data-to="open">פתיחה מחדש</button>` : ''}` : `<span class="badge st-in_progress">פתוחה</span>${can('change_status') ? ` <button class="btn sm" data-evst="${e.id}" data-to="resolved">סימון כהוסדרה</button>` : ''}${can('send_voice') ? ` <button class="btn sm" data-evvoice="${e.id}" title="הודעה קולית רק על הוראה זו">📞 הודעה רק עליה</button>` : ''}`}</td>
            ${can('delete') ? `<td><button class="btn sm danger" data-delev="${e.id}">מחיקה</button></td>` : ''}</tr>`).join('')}
          </tbody><tfoot><tr><td><strong>סה"כ</strong></td><td class="num"><strong>${money(c.total_amount)}</strong></td><td colspan="9"></td></tr></tfoot></table></div>
        </div>
        <div class="card">
          <h2>תיעוד פעולה / שיחה</h2>
          <form id="actForm">
            <div class="grid2">
              <div class="field"><label>סוג פעולה</label><select name="type">${Object.entries(ACTION_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
              <div class="field"><label>תאריך מעקב הבא (לא חובה)</label><input type="date" name="followup_date" min="${todayIso()}"></div>
            </div>
            <div class="field"><label>תיאור</label><textarea name="text" placeholder="לדוגמה: דיברתי עם האדם. התחייב לשלם את כל החובות בחודש הבא."></textarea></div>
            <button class="btn primary">שמירת פעולה</button>
          </form>
        </div>
        <div class="card">
          <h2>היסטוריית פעולות</h2>
          ${actions.length ? `<ul class="timeline">${actions.map((a) => `<li class="${ACTION_TYPES[a.type] ? '' : 'sys'}">
            <div class="meta">${fdate(a.created_at)}<br>${esc(a.user_name || 'מערכת')}<div class="kind">${esc(ACTION_TYPES[a.type] || SYS_TYPES[a.type] || a.type)}</div></div>
            <div class="txt">${esc(a.text)}</div></li>`).join('')}</ul>` : '<div class="empty">אין פעולות עדיין</div>'}
        </div>
        ${assignments.length ? `<div class="card"><h2>היסטוריית שיוכים</h2><table><thead><tr><th>תאריך</th><th>ממטפל</th><th>למטפל</th><th>בוצע ע"י</th><th>הערה</th></tr></thead><tbody>
          ${assignments.map((a) => `<tr><td class="nowrap small">${fdate(a.created_at)}</td><td>${esc(a.from_name || '—')}</td><td>${esc(a.to_name || '—')}</td><td>${esc(a.by_name || '')}</td><td class="small">${esc(a.note || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div>
    </div>`);
  bindShell();
  const reload = () => renderCase(id);
  document.getElementById('actForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', `/api/cases/${id}/actions`, formData(e.target)); toast('הפעולה נשמרה'); reload(); } catch (err) { toast(err.message, true); }
  };
  document.getElementById('chAssign').onclick = () => { assignDialog([c.id], c.assigned_user_id); };
  const confirmDelete = (title, text, url, after) => {
    const m = modal(`<h2>${title}</h2><p>${text}</p><p class="small muted">אם תייבא שוב את אותו קובץ, מה שנמחק לא ייקלט שוב.</p>
      <div class="field"><label>סיבה (לא חובה)</label><input type="text" name="reason" placeholder="למשל: שורה כפולה / טעות בקובץ"></div>
      <div class="modal-actions"><button class="btn danger" id="ok">מחיקה סופית</button><button class="btn" data-close>ביטול</button></div>`);
    m.querySelector('#ok').onclick = async () => { try { const r = await api('DELETE', url, formData(m)); m.remove(); toast('נמחק'); after(r); } catch (e) { toast(e.message, true); } };
  };
  document.querySelectorAll('[data-evedit]').forEach((b) => b.addEventListener('click', () => {
    const e = events.find((x) => x.id === +b.dataset.evedit); if (!e) return;
    const ym = (() => { const m = String(e.expiry || '').match(/^(\d{1,2})\s*[\/\-.]\s*(\d{2,4})$/); return m ? `${m[2].length === 2 ? '20' + m[2] : m[2]}-${String(m[1]).padStart(2, '0')}` : ''; })();
    const m = modal(`<h2>עדכון הוראה</h2>
      <div class="field"><label>סעיף חיוב</label><input type="text" name="charge_item" value="${esc(e.charge_item || '')}"></div>
      <div class="field"><label>חודש ושנה של פקיעת התוקף (ריק = אין)</label><input type="month" name="expiry_month" value="${ym}"></div>
      <div class="modal-actions"><button class="btn primary" id="ok">שמירה</button><button class="btn" data-close>ביטול</button></div>`);
    m.querySelector('#ok').onclick = async () => { try { await api('PUT', `/api/events/${e.id}`, formData(m)); m.remove(); toast('עודכן'); reload(); } catch (err) { toast(err.message, true); } };
  }));
  document.querySelectorAll('[data-evvoice]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('לשלוח הודעה קולית רק על ההוראה הזו?\n(אם הוא יחזור לקו – ישמע את ההודעה הרגילה על כל ההוראות הפתוחות)')) return;
    b.disabled = true;
    const g = await warmGate({ event_id: +b.dataset.evvoice }); if (!g) { b.disabled = false; return; }
    try { const r = await api('POST', `/api/events/${b.dataset.evvoice}/voice`, g); toast(r.window ? r.window.label : 'נשלח'); reload(); } catch (err) { b.disabled = false; toast(err.message, true); }
  }));
  document.querySelectorAll('[data-evst]').forEach((b) => b.addEventListener('click', () => {
    const e = events.find((x) => x.id === +b.dataset.evst);
    const toOpen = b.dataset.to === 'open';
    const m = modal(`<h2>${toOpen ? 'פתיחה מחדש של הוראה' : 'סימון הוראה כהוסדרה'}</h2><p>${fdate(e.charge_date)} · ${money(e.amount)}${e.charge_item ? ' · ' + esc(e.charge_item) : ''}</p>
      ${toOpen ? '' : '<label class="check"><input type="checkbox" name="confirm_settled"> אני מאשר/ת שהתשלום עבור הוראה זו הוסדר</label><br>'}
      <div class="field"><label>הערה</label><input type="text" name="note"></div>
      <p class="small muted">כל הוראה נשמרת עם סטטוס משלה. הודעות הבאות יתייחסו רק להוראות שעדיין פתוחות. כשכל ההוראות בתיק הוסדרו – התיק נסגר.</p>
      <div class="modal-actions"><button class="btn primary" id="ok">שמירה</button><button class="btn" data-close>ביטול</button></div>`);
    m.querySelector('#ok').onclick = async () => { try { const r = await api('POST', `/api/events/${e.id}/status`, { status: b.dataset.to, ...formData(m) }); m.remove(); toast(r.caseClosed ? 'כל ההוראות הוסדרו – התיק נסגר' : 'נשמר'); reload(); } catch (err) { toast(err.message, true); } };
  }));
  document.querySelectorAll('[data-delev]').forEach((b) => b.addEventListener('click', () => {
    const e = events.find((x) => x.id === +b.dataset.delev);
    confirmDelete('מחיקת שורת חיוב', `למחוק את השורה ${fdate(e.charge_date)} · ${money(e.amount)}${e.charge_item ? ' · ' + esc(e.charge_item) : ''}?${events.length === 1 ? ' <strong>זו השורה היחידה בתיק, ולכן גם התיק יימחק.</strong>' : ''}`,
      `/api/events/${e.id}`, (r) => (r.caseDeleted ? (location.hash = '#/cases') : reload()));
  }));
  const dc = document.getElementById('delCase');
  if (dc) dc.onclick = () => confirmDelete('מחיקת תיק', `למחוק לגמרי את התיק של ${esc(ct.full_name || '')} (${events.length} שורות, ${money(c.total_amount)})?`, `/api/cases/${c.id}`, () => (location.hash = '#/cases'));
  document.getElementById('addEv').onclick = () => {
    const m = modal(`<h2>הוספת חיוב ידנית</h2>${eventFields()}<div class="modal-actions"><button class="btn primary" id="ok">שמירה</button><button class="btn" data-close>ביטול</button></div>`, 'wide');
    m.querySelector('#ok').onclick = async (ev) => { ev.target.disabled = true; try { await api('POST', `/api/cases/${c.id}/events`, formData(m)); m.remove(); toast('החיוב נוסף'); reload(); } catch (e) { ev.target.disabled = false; toast(e.message, true); } };
  };
  const lc = document.getElementById('logCall'); if (lc) lc.onclick = () => outcomeDialog({ ...c, phone1: ct.phone1, phone2: ct.phone2, phone3: ct.phone3 }, reload);
  document.getElementById('saveFu').onclick = async () => {
    try { await api('POST', `/api/cases/${id}/followup`, { followup_date: document.getElementById('fu').value || null }); toast('תאריך המעקב עודכן'); reload(); } catch (err) { toast(err.message, true); }
  };
  if (document.getElementById('autoCall')) document.getElementById('autoCall').onclick = async () => {
    const phones = [ct.phone1, ct.phone2, ct.phone3].filter(Boolean);
    if (!phones.length) return toast('אין מספר טלפון לאדם זה', true);
    const m = modal(`<h2>שיחה אוטומטית</h2>
      <div class="notice warn" id="phSt">בודק סטטוס חיבור…</div>
      <div class="field"><label>מספר</label><select name="phone">${phones.map((p) => `<option>${esc(p)}</option>`).join('')}</select></div>
      <p class="small muted">האדם ישמע את נוסח ההודעה של סוג הקובץ, עם תפריט: 1 – תשלום בנדרים פלוס, 2 – השארת הודעה למזכירות, 3 – תזכורת טלפונית בעוד כמה ימים. השיחה יוצאת מיד (בימים א'–ה' בין 9:00 ל-20:00; מחוץ לשעות אלה – ביום העבודה הבא ב-9:00). עלות: יחידה אחת.</p>
      <div class="modal-actions"><button class="btn primary" id="ok">שליחה עכשיו</button><button class="btn" data-close>ביטול</button></div>`);
    api('GET', '/api/stats').then(() => {}); // שומר סשן
    m.querySelector('#phSt').textContent = 'שימו לב: חיוג אוטומטי פועל רק לאחר חיבור ספק חיוג במסך ההגדרות.';
    m.querySelector('#ok').onclick = async () => {
      try {
        const g = await warmGate({ case_ids: [id] }); if (!g) return;
        const r = await api('POST', `/api/cases/${id}/auto-call`, { ...formData(m), ...g });
        m.remove(); toast(r.phoneStatus.state === 'not_configured' ? 'שירות החיוג לא מחובר' : r.window.label); setTimeout(reload, 4000);
      } catch (err) { toast(err.message, true); }
    };
  };
  document.getElementById('editContact').onclick = () => {
    const f = [['full_name', 'שם מלא'], ['phone1', 'טלפון 1'], ['phone2', 'טלפון 2'], ['phone3', 'טלפון 3'], ['email', 'דוא"ל'], ['address', 'כתובת'], ['city', 'עיר']];
    const m = modal(`<h2>עריכת פרטי קשר</h2><div class="grid2">${f.map(([k, l]) => `<div class="field"><label>${l}</label><input type="text" name="${k}" value="${esc(ct[k] || '')}"></div>`).join('')}</div>
      <p class="small muted">שינויים נרשמים בהיסטוריית התיק. ייבוא עתידי עשוי לעדכן פרטים לפי הקובץ.</p>
      <div class="modal-actions"><button class="btn primary" id="ok">שמירה</button><button class="btn" data-close>ביטול</button></div>`, 'wide');
    m.querySelector('#ok').onclick = async () => { try { await api('PUT', `/api/contacts/${ct.id}`, formData(m)); m.remove(); toast('נשמר'); reload(); } catch (err) { toast(err.message, true); } };
  };
  document.getElementById('chStatus').onclick = () => statusDialog(c, reload);
}

function statusDialog(c, done) {
  const m = modal(`<h2>שינוי סטטוס</h2>
    <div class="field"><label>סטטוס חדש</label><select name="status">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${k === c.status ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div id="stExtra"></div>
    <div class="field"><label id="noteLbl">הערה</label><textarea name="note"></textarea></div>
    <div class="modal-actions"><button class="btn primary" id="ok">שמירה</button><button class="btn" data-close>ביטול</button></div>`);
  const sel = m.querySelector('[name=status]');
  const upd = () => {
    const s = sel.value;
    const ex = m.querySelector('#stExtra');
    m.querySelector('#noteLbl').textContent = s === 'resolved' ? 'כיצד הוסדר החוב? (חובה)' : s === 'unresolvable' ? 'מדוע לא ניתן לטפל? (חובה)' : 'הערה';
    if (s === 'waiting') ex.innerHTML = `<div class="field"><label>תאריך מעקב (חובה)</label><input type="date" name="followup_date" min="${todayIso()}" value="${esc(c.next_followup_date && c.next_followup_date > todayIso() ? c.next_followup_date : nextMonthIso())}"></div>
      <p class="small muted">התיק יוצג ברשימת הממתינים ויחזור אוטומטית לרשימה הפעילה בתאריך זה.</p>`;
    else if (s === 'resolved') ex.innerHTML = `<div class="notice warn">יש לסמן "טופל" רק לאחר שיש אישור שהחוב הוסדר בפועל.</div>
      <label class="check"><input type="checkbox" name="confirm_settled"> אני מאשר/ת שהחוב בסך ${money(c.total_amount)} הוסדר</label><br>`;
    else ex.innerHTML = '';
  };
  sel.onchange = upd; upd();
  m.querySelector('#ok').onclick = async () => {
    try { await api('POST', `/api/cases/${c.id}/status`, formData(m)); m.remove(); toast('הסטטוס עודכן'); done(); } catch (err) { toast(err.message, true); }
  };
}

// ---------- עובדים ----------
async function renderWorkers() {
  await loadUsers();
  const hist = await api('GET', '/api/assignments');
  const active = state.users.filter((u) => u.active);
  const inactive = state.users.filter((u) => !u.active);
  $app.innerHTML = shell('workers', `
    <div class="page-head"><div><h1>עובדים ושיוך תיקים</h1><p class="sub">${state.unassigned ? `${state.unassigned} תיקים פתוחים ללא מטפל – <a href="#/cases" id="goUnassigned">לשיוך</a>` : 'כל התיקים הפתוחים משויכים'}</p></div>
      ${isAdmin() ? '<button class="btn primary" id="addUser">הוספת עובד</button>' : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>שם</th>${isAdmin() ? '<th>שם משתמש</th><th>דוא"ל</th>' : ''}<th>הרשאה</th><th class="num">תיקים פתוחים</th><th class="num">סכום פתוח</th><th class="num">תיקים שטופלו</th>${isAdmin() ? '<th>פעולות</th>' : ''}</tr></thead><tbody>
    ${active.map((u) => `<tr>
      <td><strong>${esc(u.full_name)}</strong></td>
      ${isAdmin() ? `<td>${u.username ? esc(u.username) : '<span class="muted">—</span>'}${u.can_login ? '' : ' <span class="badge pill-mid">ללא כניסה</span>'}</td><td class="small">${esc(u.email || '')}</td>` : ''}
      <td>${u.role === 'admin' ? 'מנהל' : 'מטפל'}</td>
      <td class="num"><a href="#/cases" data-filter="${u.id}">${u.open_cases}</a></td><td class="num">${money(u.open_amount)}</td><td class="num">${u.resolved_cases}</td>
      ${isAdmin() ? `<td class="nowrap"><button class="btn sm" data-edit="${u.id}">עריכה</button> <button class="btn sm" data-transfer="${u.id}" ${u.open_cases ? '' : 'disabled'}>העברת תיקים</button> ${u.id !== state.me.id ? `<button class="btn sm danger" data-remove="${u.id}">הסרה</button>` : ''}</td>` : ''}
    </tr>`).join('')}</tbody></table></div>
    ${inactive.length && isAdmin() ? `<div class="card" style="margin-top:16px"><h3>עובדים שהוסרו (ההיסטוריה שלהם נשמרת)</h3>${inactive.map((u) => `<div class="row small">${esc(u.full_name)} <button class="btn sm" data-restore="${u.id}">החזרה</button></div>`).join('')}</div>` : ''}
    <div class="card" style="margin-top:16px"><h2>היסטוריית שיוכים</h2>
      ${hist.length ? `<div class="table-wrap"><table><thead><tr><th>תאריך</th><th>תיק</th><th>ממטפל</th><th>למטפל</th><th>בוצע ע"י</th><th>הערה</th></tr></thead><tbody>
      ${hist.map((a) => `<tr><td class="nowrap small">${fdate(a.created_at)}</td><td><a href="#/case/${a.case_id}">${esc(a.contact_name || a.external_id)}</a></td><td>${esc(a.from_name || '—')}</td><td>${esc(a.to_name || '—')}</td><td>${esc(a.by_name || '')}</td><td class="small">${esc(a.note || '')}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">אין עדיין שיוכים</div>'}</div>`);
  bindShell();
  const ga = document.getElementById('goUnassigned'); if (ga) ga.onclick = () => { state.assignee = 'none'; state.view = 'open'; };
  document.querySelectorAll('[data-filter]').forEach((a) => a.addEventListener('click', () => { state.assignee = a.dataset.filter; state.view = 'open'; }));
  if (!isAdmin()) return;
  document.getElementById('addUser').onclick = () => userDialog();
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => userDialog(state.users.find((u) => u.id === +b.dataset.edit))));
  document.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => { await api('PUT', `/api/users/${b.dataset.restore}`, { active: true }); renderWorkers(); }));
  const transferDlg = (uid, remove) => {
    const u = state.users.find((x) => x.id === uid);
    const m = modal(`<h2>${remove ? 'הסרת עובד' : 'העברת תיקים'}: ${esc(u.full_name)}</h2>
      ${remove ? '<p>העובד יושבת ולא יוכל להיכנס. כל ההיסטוריה שלו נשמרת.</p>' : ''}
      ${u.open_cases ? `<div class="field"><label>להעביר את ${u.open_cases} התיקים הפתוחים אל</label><select name="transfer_to">${state.users.filter((x) => x.active && x.id !== uid).map((x) => `<option value="${x.id}">${esc(x.full_name)}</option>`).join('')}<option value="">— ללא מטפל —</option></select></div>` : ''}
      <div class="modal-actions"><button class="btn ${remove ? 'danger' : 'primary'}" id="ok">${remove ? 'הסרה' : 'העברה'}</button><button class="btn" data-close>ביטול</button></div>`);
    m.querySelector('#ok').onclick = async () => {
      try { const r = await api('POST', `/api/users/${uid}/${remove ? 'remove' : 'transfer'}`, formData(m)); m.remove(); toast(`הועברו ${r.transferred} תיקים`); renderWorkers(); } catch (e) { toast(e.message, true); }
    };
  };
  document.querySelectorAll('[data-transfer]').forEach((b) => b.addEventListener('click', () => transferDlg(+b.dataset.transfer, false)));
  document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => transferDlg(+b.dataset.remove, true)));
}
async function userDialog(u) {
  if (!state.sources.length) await loadSources();
  const defs = state.permDefs || {};
  const perms = (u && u.perms) || Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, v.def]));
  const srcIds = u && u.source_ids ? String(u.source_ids).split(',').map(Number) : [];
  const m = modal(`<h2>${u ? 'עריכת עובד' : 'הוספת עובד'}</h2>
    <div class="grid2">
      <div class="field"><label>שם מלא *</label><input type="text" name="full_name" value="${esc(u ? u.full_name : '')}"></div>
      <div class="field"><label>דוא"ל (לתזכורות)</label><input type="email" name="email" value="${esc(u ? u.email || '' : '')}"></div>
      <div class="field"><label>טלפון</label><input type="text" name="phone" value="${esc(u ? u.phone || '' : '')}"></div>
      <div class="field"><label>תפקיד</label><select name="role" id="roleSel"><option value="worker">עובד (לפי ההרשאות שלמטה)</option><option value="admin" ${u && u.role === 'admin' ? 'selected' : ''}>מנהל מערכת (רואה הכל)</option></select></div>
      <div class="field"><label>שם משתמש לכניסה</label><input type="text" name="username" value="${esc(u ? u.username || '' : '')}" autocomplete="off"></div>
      <div class="field"><label>${u && u.can_login ? 'סיסמה חדשה (ריק = ללא שינוי)' : 'סיסמה (8 תווים לפחות)'}</label><input type="password" name="password" autocomplete="new-password"></div>
    </div>
    <div id="permBox">
      <h3>המוסדות שהעובד אחראי עליהם</h3>
      <p class="small muted">העובד יראה רק תיקים, הודעות והקלטות של המוסדות שסומנו (וכן תיקים שמשויכים אליו אישית).</p>
      <div class="row">${state.sources.filter((x) => x.active).map((x) => `<label class="check"><input type="checkbox" data-src="${x.id}" ${srcIds.includes(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('') || '<span class="muted small">אין מוסדות</span>'}</div>
      <h3 style="margin-top:12px">מה העובד רשאי לראות ולעשות</h3>
      <div class="grid2">${Object.entries(defs).map(([k, v]) => `<label class="check"><input type="checkbox" data-perm="${k}" ${perms[k] ? 'checked' : ''}> ${esc(v.label)}</label>`).join('')}</div>
    </div>
    <div class="modal-actions"><button class="btn primary" id="ok">שמירה</button><button class="btn" data-close>ביטול</button></div>`, 'wide');
  const sync = () => { m.querySelector('#permBox').style.opacity = m.querySelector('#roleSel').value === 'admin' ? 0.4 : 1; };
  m.querySelector('#roleSel').onchange = sync; sync();
  m.querySelector('#ok').onclick = async () => {
    const d = formData(m); if (!d.password) delete d.password;
    d.perms = Object.fromEntries([...m.querySelectorAll('[data-perm]')].map((c) => [c.dataset.perm, c.checked]));
    d.source_ids = [...m.querySelectorAll('[data-src]')].filter((c) => c.checked).map((c) => +c.dataset.src);
    try { await api(u ? 'PUT' : 'POST', u ? `/api/users/${u.id}` : '/api/users', d); m.remove(); toast('נשמר'); renderWorkers(); } catch (e) { toast(e.message, true); }
  };
}

// ---------- ייבוא ----------
async function renderImport() {
  const [imports] = await Promise.all([api('GET', '/api/imports'), loadSources(), loadUsers()]);
  const act = state.sources.filter((x) => x.active);
  $app.innerHTML = shell('import', `
    <div class="page-head"><div><h1>ייבוא קובץ החזרות חודשי</h1><p class="sub">קובץ Excel (‎.xlsx‎) או CSV. העמודות מזוהות אוטומטית לפי הכותרות, וניתן לתקן את המיפוי לפני הקליטה.</p></div></div>
    <div class="card" id="step">
      ${act.length ? `<div class="grid2"><div class="field"><label>1. סוג הקובץ</label><select id="srcSel">${act.map((x) => `<option value="${x.id}" ${String(x.id) === state.importSource ? 'selected' : ''}>${esc(x.name)} – ${esc(x.assignee_name || 'ללא אחראי')}</option>`).join('')}</select></div>
      <div class="field"><label>2. בחירת קובץ</label><input type="file" id="file" accept=".xlsx,.csv,.xls"></div></div>`
      : '<div class="notice warn">לפני הייבוא צריך להגדיר לפחות סוג קובץ אחד. <a href="#/sources">להגדרת סוגי קבצים</a></div>'}
      <p class="small muted">חיובים נאספים לתיק אחד לפי <strong>מזהה איש קשר</strong>. ייבוא חוזר של אותם חיובים מזוהה ככפילות ואינו נקלט פעמיים. ההיסטוריה הקיימת אינה נמחקת.</p>
    </div>
    <div class="card"><h2>היסטוריית ייבוא</h2>
    ${imports.length ? `<div class="table-wrap"><table><thead><tr><th>תאריך</th><th>סוג</th><th>קובץ</th><th>תקופה</th><th>הועלה ע"י</th><th class="num">שורות</th><th class="num">נקלטו</th><th class="num">כפילויות</th><th class="num">שגיאות</th><th class="num">תיקים חדשים</th><th class="num">תיקים שעודכנו</th><th class="num">סכום</th></tr></thead><tbody>
      ${imports.map((i) => `<tr><td class="nowrap small">${fdate(i.created_at)}</td><td>${esc(i.source_name || '')}</td><td>${esc(i.filename)}</td><td>${esc(i.period_label || '')}</td><td>${esc(i.uploaded_by_name || '')}</td>
      <td class="num">${i.rows_total}</td><td class="num">${i.rows_imported}</td><td class="num">${i.rows_duplicate}</td><td class="num">${i.rows_error}</td><td class="num">${i.cases_created}</td><td class="num">${i.cases_updated}</td><td class="num">${money(i.total_amount)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">טרם בוצע ייבוא</div>'}</div>`);
  bindShell();
  const fileEl = document.getElementById('file');
  if (!fileEl) return;
  document.getElementById('srcSel').onchange = (e) => (state.importSource = e.target.value);
  fileEl.onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const srcId = document.getElementById('srcSel').value; state.importSource = srcId;
    const src = state.sources.find((x) => String(x.id) === srcId);
    const step = document.getElementById('step');
    step.innerHTML = '<div class="empty">מנתח את הקובץ…</div>';
    try {
      const r = await fetch('/api/import/analyze', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(file.name), 'X-Source-Id': srcId, 'Content-Type': 'application/octet-stream' }, body: file });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      data.source = src;
      renderMapping(data);
    } catch (err) { step.innerHTML = `<div class="notice err">${esc(err.message)}</div><button class="btn" onclick="route()">ניסיון נוסף</button>`; }
  };
}

function renderMapping(data) {
  const step = document.getElementById('step');
  let sheetIdx = 0;
  const draw = () => {
    const sh = data.sheets[sheetIdx];
    const opts = (field) => `<option value="">— לא קיים בקובץ —</option>` + sh.headers.map((h, i) => `<option value="${i}" ${sh.mapping[field] === i ? 'selected' : ''}>${esc(h)}</option>`).join('');
    const now = new Date();
    const unmapped = sh.headers.filter((_, i) => !Object.values(sh.mapping).includes(i));
    step.innerHTML = `
      <h2>מיפוי עמודות – ${esc(data.filename)}</h2>
      <p>סוג הקובץ: <strong>${esc(data.source.name)}</strong> · תיקים חדשים יוקצו ל<strong>${esc(data.source.assignee_name || 'ללא אחראי')}</strong></p>
      ${sh.fromSaved ? '<div class="notice ok">המיפוי נטען מהייבוא הקודם של הסוג הזה. אפשר לבדוק ולהמשיך.</div>' : ''}
      ${data.previousImport ? `<div class="notice warn">קובץ זהה כבר יובא ב-${fdate(data.previousImport.created_at)}. אפשר להמשיך – חיובים שכבר קיימים יזוהו ככפילויות ולא ייקלטו שוב.</div>` : ''}
      ${data.sheets.length > 1 ? `<div class="field"><label>גיליון</label><select id="sheetSel" style="width:auto">${data.sheets.map((s, i) => `<option value="${i}" ${i === sheetIdx ? 'selected' : ''}>${esc(s.sheet)} (${s.rowCount} שורות)</option>`).join('')}</select></div>` : ''}
      <p class="small muted">שורת הכותרות זוהתה בשורה ${sh.headerRow}. ${sh.rowCount} שורות נתונים. עמודות שלא מופו יישמרו כמידע נוסף בכרטיס האדם ובפירוט החיוב.</p>
      <div class="field" style="max-width:320px"><label>תיאור תקופה (לזיהוי הייבוא)</label><input type="text" id="period" value="החזרות ${now.getMonth() === 0 ? 12 : now.getMonth()}/${now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()}"></div>
      <div class="grid3">
        ${Object.entries(data.fields).map(([k, f]) => `<div class="field"><label>${esc(f.label)}${f.required === true || f.required === data.source.kind ? ' <span style="color:var(--danger)">*</span>' : ''}</label><select data-field="${k}">${opts(k)}</select></div>`).join('')}
      </div>
      ${unmapped.length ? `<div class="small muted">עמודות שלא מופו: ${unmapped.map(esc).join(', ')}</div>` : ''}
      <h3 style="margin-top:16px">תצוגה מקדימה</h3>
      <div class="table-wrap"><table><thead><tr>${sh.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
        ${sh.sample.map((r) => `<tr>${sh.headers.map((_, i) => `<td class="small nowrap">${esc(r[i])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="modal-actions"><button class="btn primary" id="commit">קליטת הנתונים</button><button class="btn" onclick="route()">ביטול</button></div>`;
    const ss = document.getElementById('sheetSel'); if (ss) ss.onchange = () => { sheetIdx = +ss.value; draw(); };
    step.querySelectorAll('[data-field]').forEach((s) => s.addEventListener('change', () => { sh.mapping[s.dataset.field] = s.value === '' ? undefined : +s.value; }));
    document.getElementById('commit').onclick = async (ev) => {
      ev.target.disabled = true; ev.target.textContent = 'קולט…';
      try {
        const res = await api('POST', '/api/import/commit', { token: data.token, sheet: sh.sheet, mapping: sh.mapping, period_label: document.getElementById('period').value });
        renderImportSummary(res);
      } catch (err) { toast(err.message, true); ev.target.disabled = false; ev.target.textContent = 'קליטת הנתונים'; }
    };
  };
  draw();
}
async function voiceApproval(importId) {
  const box = document.getElementById('voiceApprove');
  if (!box || !importId) return;
  const d = await api('GET', `/api/voice/import/${importId}`);
  if (!d.withPhone) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card" style="margin-top:12px;border-color:var(--primary)"><h3>שליחת הודעות קוליות</h3>
    <p>לשלוח הודעה קולית אישית ל-<strong>${d.withPhone}</strong> אנשים מהקובץ הזה? כל אחד ישמע את השם שלו, הסכום והסעיף, ואת המספר לחזור אליו.</p>
    <p class="small muted">${d.mode === 'unified' && d.multi ? `ל-${d.multi} אנשים יש יותר מהוראה אחת – כל אחד יקבל הודעה אחת מאוחדת. ` : ''}עלות משוערת: עד ${d.withPhone} יחידות.${d.noPhone ? ` ל-${d.noPhone} אנשים אין טלפון והם לא יקבלו הודעה.` : ''} השיחות יוצאות רק בזמני השליחה שהוגדרו.</p>
    <div class="row"><button class="btn primary" id="vaOk">אישור שליחה ל-${d.withPhone} אנשים</button><button class="btn" id="vaNo">לא עכשיו</button></div></div>`;
  document.getElementById('vaNo').onclick = () => (box.innerHTML = '<p class="small muted">לא נשלחו הודעות. אפשר לשלוח מאוחר יותר ממסך "הודעות קוליות".</p>');
  document.getElementById('vaOk').onclick = async (e) => {
    e.target.disabled = true;
    const g = await warmGate({ import_id: importId }); if (!g) return;
    try { const r = await api('POST', `/api/voice/import/${importId}`, g); box.innerHTML = `<div class="notice ok">${r.queued} הודעות: ${r.window.label}. אפשר לעקוב במסך <a href="#/voice">הודעות קוליות</a>.</div>`; }
    catch (err) { e.target.disabled = false; toast(err.message, true); }
  };
}
function renderImportSummary(r) {
  setTimeout(() => voiceApproval(r.importId), 0);
  const step = document.getElementById('step');
  step.innerHTML = `<h2>סיכום קליטה</h2>
    <div class="notice ${r.rows_imported ? 'ok' : 'warn'}">${r.rows_imported ? 'הקליטה הושלמה בהצלחה.' : 'לא נקלטו חיובים חדשים.'}${r.sameFileImportedBefore ? ' (קובץ זהה יובא בעבר)' : ''}</div>
    <div class="stat-row">
      <div class="stat"><div class="v">${r.rows_total}</div><div class="l">שורות בקובץ</div></div>
      <div class="stat"><div class="v">${r.rows_imported}</div><div class="l">חיובים שנקלטו</div></div>
      <div class="stat"><div class="v">${r.cases_created}</div><div class="l">תיקים חדשים שנוצרו</div></div>
      <div class="stat"><div class="v">${r.cases_updated}</div><div class="l">תיקים פתוחים שעודכנו</div></div>
      <div class="stat"><div class="v">${r.rows_duplicate}</div><div class="l">כפילויות שזוהו ודולגו${r.duplicate_amount ? ` (${money(r.duplicate_amount)})` : ''}</div></div>
      <div class="stat"><div class="v">${r.rows_error}</div><div class="l">שורות שגויות</div></div>
      <div class="stat"><div class="v">${money(r.total_amount)}</div><div class="l">סכום כולל שנקלט</div></div>
    </div>
    ${r.errors.length ? `<details><summary>פירוט שורות שלא נקלטו (${r.rows_error})</summary><ul class="small">${r.errors.map((e) => `<li>שורה ${e.row}: ${esc(e.error)}</li>`).join('')}</ul></details>` : ''}
    <div id="voiceApprove"></div>
    <div class="modal-actions"><a class="btn primary" href="#/cases">למסך התיקים</a><button class="btn" onclick="route()">ייבוא קובץ נוסף</button></div>`;
}

// ---------- תזכורות ואוטומציות ----------
async function renderAutomation() {
  const d = await api('GET', '/api/automation');
  const pill = (s) => `<span class="badge ${s.state === 'active' ? 'pill-ok' : s.state === 'configured' ? 'pill-mid' : 'pill-off'}">${s.state === 'active' ? 'פעיל' : s.state === 'configured' ? 'הוגדר' : 'לא מחובר'}</span>`;
  const OUT = { draft: 'טיוטה – לא נשלח', sent: 'נשלח', failed: 'נכשל', queued: 'בתור' };
  $app.innerHTML = shell('automation', `
    <div class="page-head"><div><h1>תזכורות ואוטומציות</h1><p class="sub">מה פועל כעת ומה דורש חיבור לשירות חיצוני</p></div>
      <div class="row"><button class="btn" id="digest">הכנת מייל סיכום לכל עובד</button><button class="btn primary" id="run">הרצת בדיקת תזכורות עכשיו</button></div></div>
    <div class="card"><h2>מצב הרכיבים</h2>
      <div class="status-line"><span class="badge pill-ok">פעיל</span><div><strong>תזכורת על תיק שלא טופל ${d.staleDays} ימים</strong><div class="small muted">תזכורת פנימית בפעמון של המטפל (ולמנהל אם אין מטפל). נבדק אוטומטית כל 30 דקות. מספר הימים ניתן לשינוי בהגדרות.</div></div></div>
      <div class="status-line"><span class="badge pill-ok">פעיל</span><div><strong>תזכורת במועד המעקב הבא + החזרת "ממתין לחודש הבא" לרשימה הפעילה</strong><div class="small muted">ביום שנקבע התיק עובר אוטומטית ל"בטיפול" ונשלחת תזכורת פנימית למטפל.</div></div></div>
      <div class="status-line"><span class="badge pill-ok">פעיל</span><div><strong>הכנת הודעות מייל לעובדים</strong><div class="small muted">לכל תזכורת נוצרת טיוטת מייל בתיבת היוצא שלמטה.</div></div></div>
      <div class="status-line">${pill(d.email)}<div><strong>שליחת מייל בפועל</strong><div class="small muted">${esc(d.email.label)}. ${d.email.state !== 'active' ? 'ההודעות נשמרות כטיוטות ואינן נשלחות. <a href="#/settings">לחיבור שרת מייל</a>' : ''}</div></div></div>
      <div class="status-line">${pill(d.phone)}<div><strong>שיחה אוטומטית עם הודעה מוקלטת</strong><div class="small muted">${esc(d.phone.label)}. ${d.phone.state === 'not_configured' ? 'בקשות שיחה נשמרות בתור ואינן מתבצעות. <a href="#/settings">להגדרת ספק</a>' : 'יש לוודא שפורמט הבקשה מתאים לתיעוד הספק.'}</div></div></div>
    </div>
    <div class="card"><h2>תיבת יוצא – מיילים לעובדים</h2>
      ${d.outbox.length ? `<div class="table-wrap"><table><thead><tr><th>נוצר</th><th>אל</th><th>נושא</th><th>מצב</th><th></th></tr></thead><tbody>
      ${d.outbox.map((o) => `<tr><td class="nowrap small">${fdate(o.created_at)}</td><td>${esc(o.to_name || '')} <span class="muted small ltr">${esc(o.to_email || 'אין כתובת')}</span></td>
        <td><a href="#" data-mail="${o.id}">${esc(o.subject)}</a></td><td><span class="badge ${o.status === 'sent' ? 'pill-ok' : o.status === 'failed' ? 'pill-off' : 'pill-mid'}">${OUT[o.status] || esc(o.status)}</span>${o.error ? `<div class="small" style="color:var(--danger)">${esc(o.error)}</div>` : ''}</td>
        <td>${o.status !== 'sent' ? `<button class="btn sm danger" data-delmail="${o.id}">מחיקה</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">אין הודעות</div>'}
    </div>
    <div class="card"><h2>תור שיחות אוטומטיות</h2>
      ${d.calls.length ? `<div class="table-wrap"><table><thead><tr><th>נוצר</th><th>אדם</th><th>טלפון</th><th>מצב</th><th></th></tr></thead><tbody>
      ${d.calls.map((q) => `<tr><td class="nowrap small">${fdate(q.created_at)}</td><td><a href="#/case/${q.case_id}">${esc(q.full_name)}</a></td><td><span class="ltr">${esc(q.phone)}</span></td>
        <td>${q.status === 'pending' ? (d.phone.state === 'not_configured' ? '<span class="badge pill-off">ממתין לחיבור ספק</span>' : '<span class="badge pill-mid">בתור</span>') : esc(q.status)}${q.error ? `<div class="small" style="color:var(--danger)">${esc(q.error)}</div>` : ''}</td>
        <td>${q.status === 'pending' ? `<button class="btn sm danger" data-delcall="${q.id}">ביטול</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">אין שיחות בתור</div>'}
    </div>`);
  bindShell();
  document.getElementById('run').onclick = async () => {
    const r = await api('POST', '/api/automation/run');
    toast(`נוצרו ${r.notificationsCreated} תזכורות חדשות, ${r.returnedToActive} תיקים חזרו לרשימה הפעילה${r.mail.sent ? `, נשלחו ${r.mail.sent} מיילים` : ''}`);
    renderAutomation();
  };
  document.getElementById('digest').onclick = async () => { const r = await api('POST', '/api/automation/digest'); toast(`הוכנו ${r.prepared} מיילי סיכום`); renderAutomation(); };
  document.querySelectorAll('[data-mail]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const o = d.outbox.find((x) => x.id === +a.dataset.mail);
    modal(`<h2>${esc(o.subject)}</h2><p class="small muted">אל: ${esc(o.to_email || 'לעובד אין כתובת מייל')}</p><div class="card" style="white-space:pre-wrap">${esc(o.body)}</div><div class="modal-actions"><button class="btn" data-close>סגירה</button></div>`, 'wide');
  }));
  document.querySelectorAll('[data-delmail]').forEach((b) => b.addEventListener('click', async () => { await api('DELETE', `/api/outbox/${b.dataset.delmail}`); renderAutomation(); }));
  document.querySelectorAll('[data-delcall]').forEach((b) => b.addEventListener('click', async () => { await api('DELETE', `/api/calls/${b.dataset.delcall}`); renderAutomation(); }));
}

// ---------- הגדרות ----------
async function renderSettings() {
  const { settings: s, email, phone: ph, stt, calendar: cal } = await api('GET', '/api/settings');
  const inp = (k, l, type = 'text', extra = '') => `<div class="field"><label>${l}</label><input type="${type}" name="${k}" value="${esc(s[k] || '')}" ${extra}></div>`;
  const ta = (k, l, rows = 2) => `<div class="field"><label>${l}</label><textarea name="${k}" rows="${rows}">${esc(s[k] || '')}</textarea></div>`;
  const sel = (k, l, opts) => `<div class="field"><label>${l}</label><select name="${k}">${opts.map(([v, t]) => `<option value="${v}" ${String(s[k]) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
  const dayNames = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
  const days = String(s.voice_days || '').split(',');
  let icons = {}; try { icons = JSON.parse(s.tab_icons || '{}'); } catch (_) { icons = {}; }
  const TABS = [['today', 'היום שלי'], ['cases', 'תיקים'], ['admin', 'דשבורד מנהל'], ['control', 'מסך בקרה'], ['people', 'אנשי קשר'], ['voice', 'הודעות קוליות'], ['workers', 'עובדים'], ['sources', 'מוסדות'], ['import', 'ייבוא'], ['automation', 'תזכורות'], ['settings', 'הגדרות']];
  $app.innerHTML = shell('settings', `
    <div class="page-head"><div><h1>הגדרות</h1><p class="sub">כל ההגדרות לפי קטגוריות. אפשר גם לחפש הגדרה</p></div><input type="search" id="setQ" class="search" placeholder="🔍 חיפוש הגדרה – למשל: שבת, מהירות, מייל"></div>
    <form id="sf">
    <div class="card"><h2>נוסחי ההודעות הקוליות</h2>
      <div class="notice info"><strong>כאן אפשר לשנות כל מילה שהמערכת אומרת בטלפון.</strong> מה שבתוך [סוגריים] המערכת ממלאת לבד לכל אדם:
        <b>[שם]</b> שם האדם · <b>[סכום]</b> סכום בשקלים · <b>[סעיף]</b> סעיף החיוב · <b>[סיבה]</b> סיבת ההחזרה · <b>[מספר]</b> כמה הוראות · <b>[מוסד]</b> שם המוסד · <b>[תוקף]</b> חודש ושנה · <b>[פירוט]</b> רשימת כל ההוראות.
        חלק שאין לו ערך (למשל אין סיבה) – יורד מהמשפט לבד. כל מוסד יכול לקבל נוסח משלו במסך "מוסדות וסוגי קבצים". <b>אחרי שינוי נוסח – כדאי ללחוץ על "שיחות חימום".</b></div>
      ${sel('send_mode', 'כשלאדם יש כמה הוראות קבע שחזרו', [['unified', 'הודעה אחת מאוחדת לאדם'], ['per_case', 'הודעה נפרדת לכל תיק / מוסד']])}
      ${ta('msg_single', 'הודעה – הוראה אחת')}
      ${ta('msg_multi', 'הודעה מאוחדת – כמה הוראות')}
      ${ta('msg_combined_intro', 'פתיחה כשיש לאדם כמה סוגי הודעות (חזרה · תוקף · אמצעי תשלום). אחריה כל הודעה ממוספרת: "הודעה ראשונה, לגבי חזרת הוראת קבע…"')}
      ${ta('msg_reminder', 'תזכורת אוטומטית – הוראה אחת')}
      ${ta('msg_reminder_multi', 'תזכורת אוטומטית – כמה הוראות')}
      <h3 style="margin-top:14px">חלקי ההודעה</h3>
      <div class="grid2">
        ${inp('line_return', 'כל שורה ב[פירוט] של החזרות (לכל סעיף)')}
        ${inp('line_expiry', 'כל שורה ב[פירוט] של פקיעת תוקף')}
      </div>
      <h3 style="margin-top:14px">כשיש לאדם כמה סוגי הודעות באותה שיחה</h3>
      <div class="grid2">
        ${inp('combined_item', 'כותרת לכל הודעה ([מספר] = ראשונה / שנייה / שלישית, [נושא] = הנושא)')}
        ${inp('combined_end', 'סיום השיחה')}
        ${inp('combined_title_returns', 'נושא: חזרת הוראת קבע')}
        ${inp('combined_title_expiry', 'נושא: תוקף אמצעי תשלום')}
        ${inp('combined_title_no_method', 'נושא: אין אמצעי תשלום')}
      </div>
    </div>
    <div class="card"><h2>המוקד הטלפוני</h2>
      <p class="small muted">התפריט של כל מוסד (טלפון, הקשה, נוסחים) מוגדר במסך "מוסדות וסוגי קבצים". כאן – נוסחים כלליים.</p>
      ${ta('ivr_unknown_greeting', 'פתיח למתקשר שאין לו תיק')}
      <div class="grid2">
        ${inp('ivr_message_digit', 'הקשה להשארת הודעה', 'text', 'maxlength="1"')}
        ${sel('tts_rate', 'מהירות ההקראה בטלפון', [['0', 'רגילה (מומלץ)'], ['2', 'קצת מהירה'], ['3', 'מהירה'], ['5', 'מהירה מאוד'], ['7', 'הכי מהירה'], ['-2', 'איטית']])}
        <div class="notice info" style="margin:6px 0 10px"><strong>הקלטה מוכנה (מומלץ):</strong> עם מפתח של גוגל, ההודעה מוקלטת מראש ומתחילה <b>מיד כשעונים, ברצף</b>, בקול טבעי יותר.</div>
        <div class="grid2">${inp('google_tts_key', 'מפתח של Google (Text-to-Speech)', 'password', 'autocomplete="new-password"')}
        ${sel('google_tts_voice', 'קול ההקלטה המוכנה', [['he-IL-Wavenet-D', 'קול גבר 1 (מומלץ)'], ['he-IL-Wavenet-B', 'קול גבר 2'], ['he-IL-Standard-D', 'קול גבר 3 (בסיסי)'], ['he-IL-Standard-B', 'קול גבר 4 (בסיסי)']])}</div>
        <div class="field"><button class="btn" type="button" id="ttsPrev">▶ השמעת דוגמה (בלי שיחה)</button> <span class="small muted">קודם שומרים, ואז לוחצים</span><audio id="ttsAudio" controls style="display:none;height:34px;vertical-align:middle;margin-inline-start:8px"></audio></div>
        ${sel('tts_voice', 'קול המקריא של ימות (כשאין הקלטה מוכנה)', [['', 'ברירת המחדל של ימות'], ['Jacob', 'יעקב (גבר)'], ['Elik_2100', 'אליק (גבר)']])}
        ${inp('ivr_message_option', 'נוסח אפשרות השארת ההודעה')}
        ${inp('ivr_record_prompt', 'הנחיה לפני ההקלטה')}
        ${inp('ivr_record_saved', 'אחרי שמירת ההודעה')}
        ${inp('ivr_invalid', 'הקשה לא תקינה')}
        ${inp('office_phone', 'טלפון משרד כללי (אם למוסד אין טלפון משלו)')}
      </div>
    </div>
    <div class="card"><h2>זמני שליחת השיחות</h2>
      <div class="field"><label>ימים</label><div class="row">${dayNames.map((n, i) => `<label class="check"><input type="checkbox" data-day="${i}" ${days.includes(String(i)) ? 'checked' : ''}> ${n}</label>`).join('')}</div></div>
      <input type="hidden" name="voice_days" id="voiceDays" value="${esc(s.voice_days)}">
      <div class="grid2">${inp('voice_hour_start', 'משעה', 'number', 'min="0" max="23"')}${inp('voice_hour_end', 'עד שעה', 'number', 'min="1" max="24"')}</div>
      <p class="small muted">שיחות שנשלחות מחוץ לזמנים האלה ממתינות ויוצאות אוטומטית בתחילת החלון הבא.</p>
    </div>
    <div class="card"><h2>🕯️ שבת וחג – עצירה אוטומטית</h2>
      <div class="notice ${cal && cal.now && cal.now.blocked ? 'warn' : 'ok'}">${cal && cal.now && cal.now.blocked ? `<strong>עכשיו ${esc(cal.now.reason)}</strong> – שום שיחה לא יוצאת. השליחה תחזור ${esc(cal.now.untilLabel)} (ובתוך שעות השליחה).` : `השליחה פעילה.${cal && cal.next ? ` העצירה הקרובה: <strong>${esc(cal.next.reason)}</strong> – מ${esc(cal.next.from)} (${esc(cal.next.fromHeb)}) עד ${esc(cal.next.to)}.` : ''}`}</div>
      <p class="small muted">המערכת מכירה לבד את כל השבתות והחגים (לוח ארץ ישראל, זמני ירושלים). בזמנים האלה אף שיחה לא יוצאת – גם לא תזכורות אוטומטיות. מה שנשלח בינתיים מחכה בתור ויוצא אחר כך.</p>
      <div class="grid2">
        ${sel('shabbat_stop_minutes', 'להפסיק לשלוח לפני הדלקת נרות', [['60', 'שעה לפני'], ['120', 'שעתיים לפני (מומלץ)'], ['180', '3 שעות לפני'], ['240', '4 שעות לפני'], ['360', '6 שעות לפני']])}
        ${sel('shabbat_resume', 'מתי לחזור לשלוח', [['next_morning', 'למחרת בבוקר – לא במוצאי שבת וחג (מומלץ)'], ['after_havdalah', 'שעה אחרי צאת השבת / החג']])}
        ${sel('block_chol_hamoed', 'חול המועד', [['1', 'לא לשלוח בחול המועד'], ['0', 'לשלוח כרגיל']])}
        ${sel('block_tisha_bav', 'תשעה באב', [['1', 'לא לשלוח בתשעה באב'], ['0', 'לשלוח כרגיל']])}
      </div>
    </div>
    <div class="card"><h2>הודעה חודשית למי שאין לו אמצעי תשלום</h2>
      <p class="small muted">הרשימה = אנשים עם תיק פתוח במוסד מסוג "מעקב אמצעי תשלום". ברגע שהתיק נסגר (אמצעי תשלום הוסדר) – האדם יוצא מהרשימה. לכל אדם נשלחת הודעה אחת בחודש לכל היותר.</p>
      <div class="grid2">${sel('monthly_enabled', 'מצב', [['0', 'כבוי'], ['1', 'מופעל']])}${inp('monthly_day', 'באיזה יום בחודש לשלוח', 'number', 'min="1" max="28"')}</div>
      ${ta('msg_no_method', 'נוסח ההודעה')}
    </div>
    <div class="card"><h2>התראה על אמצעי תשלום שעומד לפוג</h2>
      <p class="small muted">התוקף נלקח רק מעמודת "תוקף" בקבצים שמגיעים מספק הגבייה (חודש/שנה בלבד – בלי פרטי כרטיס). כשמגיע קובץ חדש עם תוקף מאוחר יותר – ההתראות נעצרות.</p>
      <div class="grid2">${sel('expiry_enabled', 'מצב', [['0', 'כבוי'], ['1', 'מופעל']])}${inp('expiry_days', 'כמה ימים לפני הפקיעה (אפשר כמה, מופרדים בפסיק)', 'text', 'placeholder="30,7"')}</div>
      ${ta('msg_expiry', 'נוסח ההודעה (הוראה אחת). [סעיף] = על מה ההוראה, [תוקף] = מתי מסתיים')}
      ${ta('msg_expiry_multi', 'נוסח כשיש כמה הוראות עם תאריכי תוקף שונים. [פירוט] = כל סעיף והתאריך שלו')}
    </div>
    <div class="card"><h2>תמלול הודעות קוליות</h2>
      ${sel('transcription_mode', 'תמלול אוטומטי בזמן השארת ההודעה', [['local', 'פעיל – תמלול מלא וחינמי בתוך המערכת (מומלץ)'], ['yemot_live', 'זיהוי דיבור של ימות המשיח בזמן השיחה (חלקי, עולה יחידות)'], ['off', 'כבוי – רק הקלטה']])}
      <p class="small muted">התמלול החינמי רץ בתוך המערכת, בלי מפתח ובלי תשלום לגורם חיצוני. כל הודעה מתומללת במלואה תוך כדקה–שתיים אחרי השיחה.</p>
      <div class="field"><button class="btn" type="button" id="trAll">תמלול כל ההקלטות הישנות שעדיין לא תומללו</button></div>
      <div class="grid2">${inp('stt_openai_key', 'מפתח OpenAI (לא חובה – רק אם רוצים שירות חיצוני במקום התמלול החינמי)', 'password', 'autocomplete="new-password"')}${inp('stt_openai_model', 'מודל (ברירת מחדל whisper-1)')}</div>
    </div>
    <div class="card"><h2>סמלים</h2>
      <div class="field"><label>סמל המערכת בכרטיסיית הדפדפן (PNG / ICO / SVG)</label>
        <div class="row"><img src="/favicon.ico?v=${Date.now()}" style="width:32px;height:32px;border:1px solid var(--border);border-radius:6px"> <span class="muted small">${s.has_favicon ? 'סמל שהועלה' : 'סמל ברירת המחדל של המערכת'}</span>
        <input type="file" id="favFile" accept="image/png,image/x-icon,image/svg+xml,image/jpeg" style="width:auto">${s.has_favicon ? '<button type="button" class="btn sm danger" id="favDel">חזרה לסמל ברירת המחדל</button>' : ''}</div></div>
      <div class="field"><label>סמל לכל כרטיסייה בתפריט (אות, מספר או אימוג'י – לא חובה)</label>
        <div class="grid3">${TABS.map(([k, l]) => `<div class="row"><input type="text" data-icon="${k}" value="${esc(icons[k] || '')}" maxlength="4" style="width:70px"> <span class="small">${l}</span></div>`).join('')}</div></div>
      <input type="hidden" name="tab_icons" id="tabIcons">
    </div>
    <div class="card"><h2>כללי</h2><div class="grid2">
      ${inp('org_name', 'שם הארגון')}
      ${inp('stale_days', 'תזכורת על תיק שלא טופל לאחר (ימים)', 'number', 'min="1" max="90"')}
    </div></div>
    <div class="card"><h2>מראה ותצוגה</h2><div class="grid3">
      ${sel('accent_color', 'צבע ראשי של המערכת', [['', 'כחול (ברירת מחדל)'], ['navy', 'כחול כהה'], ['teal', 'טורקיז'], ['green', 'ירוק'], ['purple', 'סגול'], ['brown', 'חום']])}
      ${sel('show_hebrew_dates', 'תאריך עברי ליד כל תאריך', [['1', 'להציג'], ['0', 'לא להציג']])}
      ${sel('admin_home', 'דף הבית של המנהל', [['control', 'מסך בקרה'], ['today', 'היום שלי']])}
    </div></div>
    <div class="card"><h2>שליחה חכמה וחיסכון ביחידות</h2><div class="grid2">
      ${inp('daily_call_limit', 'מקסימום שיחות ביום (0 = בלי הגבלה)', 'number', 'min="0" max="5000"')}
      ${inp('min_days_between_auto', 'הודעות אוטומטיות: לא יותר מאחת לאדם בכל X ימים (0 = בלי הגבלה)', 'number', 'min="0" max="60"')}
      ${inp('retry_unanswered_hours', 'חיוג חוזר למי שלא ענה – אחרי X שעות (0 = כבוי)', 'number', 'min="0" max="168"')}
      ${inp('retry_unanswered_max', 'כמה חיוגים חוזרים לכל היותר', 'number', 'min="0" max="5"')}
      ${inp('callback_same_minutes', 'מי שמתקשר בחזרה תוך X דקות – ישמע את אותה הודעה שקיבל (אחר כך: ההודעה המאוחדת)', 'number', 'min="2" max="120"')}
      ${sel('warm_check', 'לפני שליחה – לבדוק אם יש חלקים חדשים ולהציע שיחת חימום', [['1', 'כן (מומלץ)'], ['0', 'לא']])}
    </div><p class="small muted">חיוג חוזר ומגבלת שיחות לא פועלים בשבת וחג ומחוץ לשעות השליחה – השיחות מחכות לחלון הבא.</p></div>
    <div class="card"><h2>אבטחה</h2><div class="grid2">
      ${inp('session_days', 'כמה ימים להישאר מחובר במחשב (1–90)', 'number', 'min="1" max="90"')}
    </div></div>
    <div class="card"><h2>שעות התזכורות</h2><div class="grid3">
      ${inp('morning_hour', 'מייל בוקר "היום שלך" (שעה)', 'number', 'min="5" max="12"')}
      ${inp('nudge_hour', 'תזכורת "עוד לא דיברת היום" (שעה)', 'number', 'min="9" max="20"')}
      ${inp('urgent_hours', 'מייל דחוף אחרי X שעות ממועד שיחה', 'number', 'min="1" max="12"')}
      ${inp('new_contact_days', 'תיק חדש בלי קשר – אחרי X ימים', 'number', 'min="1" max="30"')}
      ${inp('escalate_days', 'הסלמה למנהל – איחור של X ימים', 'number', 'min="1" max="60"')}
    </div><p class="small muted">לא נשלחות התראות בשבת ובשישי אחרי 12:00.</p></div>
    <div class="card"><h2>🔑 דרכי כניסה למערכת</h2>
      <p class="small muted">בנוסף לשם משתמש וסיסמה. העובד מזוהה לפי <b>המייל שמעודכן אצלו במסך "עובדים"</b> – בלי מייל מעודכן, אפשר להיכנס רק עם סיסמה.</p>
      <div class="status-line"><span class="badge pill-ok">פעיל</span><span><b>קוד בשיחה קולית</b> – הטלפון מצלצל ומקריא קוד. לפי הטלפון שמעודכן אצל העובד במסך "עובדים". לא פועל בשבת וחג.</span></div>
      <div class="status-line"><span class="badge ${email.state === 'active' ? 'pill-ok' : 'pill-off'}">${email.state === 'active' ? 'פעיל' : 'לא פעיל'}</span><span><b>קוד למייל</b> – ${email.state === 'active' ? 'מופיע במסך הכניסה.' : 'יופעל לבד אחרי שיחובר שירות המייל (בהמשך העמוד).'}</span></div>
      <div class="status-line"><span class="badge ${s.google_client_id ? 'pill-ok' : 'pill-off'}">${s.google_client_id ? 'פעיל' : 'לא פעיל'}</span><span><b>כניסה עם חשבון גוגל</b> – ${s.google_client_id ? 'מופיע במסך הכניסה.' : 'צריך "מזהה לקוח" מגוגל (פעם אחת).'}</span></div>
      ${inp('google_client_id', 'מזהה לקוח של Google (Client ID – מסתיים ב-apps.googleusercontent.com)')}
    </div>
    <div class="card"><h2>שירות מייל – Brevo (מומלץ) <span class="badge ${email.state === 'active' ? 'pill-ok' : email.state === 'configured' ? 'pill-mid' : 'pill-off'}">${esc(email.label)}</span></h2>
      <p class="small muted">השרת לא יכול לשלוח מיילים ישירות, ולכן משתמשים ב-Brevo (מסלול חינמי). נרשמים ב-brevo.com, מאמתים את כתובת השולח, ויוצרים מפתח API.</p>
      <div class="grid3">
        <div class="field"><label>שירות</label><select name="email_provider"><option value="brevo" ${s.email_provider !== 'smtp' ? 'selected' : ''}>Brevo</option><option value="smtp" ${s.email_provider === 'smtp' ? 'selected' : ''}>SMTP (מתקדם)</option></select></div>
        ${inp('brevo_api_key', 'מפתח API של Brevo', 'password', 'autocomplete="new-password"')}
        ${inp('email_from_name', 'שם השולח')}
      </div></div>
    <div class="card"><h2>SMTP (רק אם בחרתם SMTP) <span class="badge ${email.state === 'active' ? 'pill-ok' : email.state === 'configured' ? 'pill-mid' : 'pill-off'}">${esc(email.label)}</span></h2>
      <p class="small muted">לשליחת מיילים בפועל נדרשים פרטי שרת SMTP – למשל חשבון Gmail/Google Workspace עם "סיסמת אפליקציה", Outlook/Microsoft 365, או שירות כמו SendGrid / Brevo. השליחה תופעל רק לאחר בדיקה מוצלחת.</p>
      <div class="grid3">
        ${inp('smtp_host', 'שרת (למשל smtp.gmail.com)')}
        ${inp('smtp_port', 'פורט (587 / 465)', 'number')}
        <div class="field"><label>הצפנה</label><select name="smtp_secure"><option value="0">STARTTLS (פורט 587)</option><option value="1" ${s.smtp_secure === '1' ? 'selected' : ''}>SSL (פורט 465)</option></select></div>
        ${inp('smtp_user', 'שם משתמש')}
        ${inp('smtp_pass', 'סיסמה / סיסמת אפליקציה', 'password', 'autocomplete="new-password"')}
      </div>
      <div class="grid3">${inp('smtp_from', 'כתובת השולח (From) – משותף ל-Brevo ול-SMTP')}</div>
      <div class="row"><input type="email" id="testTo" placeholder="כתובת לבדיקה" style="width:260px"><button type="button" class="btn" id="testMail">שמירה ושליחת מייל בדיקה</button>
        ${email.state === 'active' ? '<button type="button" class="btn danger" id="disMail">כיבוי שליחה</button>' : ''}</div>
    </div>
    <div class="card"><h2>הודעות קוליות – ימות המשיח <span class="badge ${ph.state === 'active' ? 'pill-ok' : ph.state === 'configured' ? 'pill-mid' : 'pill-off'}">${esc(ph.label)}</span></h2>
      <ol class="small" style="padding-inline-start:18px;margin-top:0">
        <li>הכניסו את מספר המערכת והסיסמה של ימות המשיח ולחצו "שמירת הגדרות".</li>
        <li>לחצו "בדיקת חיבור והתקנת השלוחה". המערכת תתקין בשלוחה שבחרתם (ברירת מחדל 9) את התפריט: 1 נדרים פלוס, 2 הודעה למזכירות, 3 תזכורת.</li>
        <li>בממשק של ימות המשיח צרו תבנית קמפיין שמעבירה את מי שעונה לשלוחה הזו, והכניסו כאן את מספר התבנית.</li>
        <li>שלחו שיחת בדיקה לטלפון שלכם.</li>
      </ol>
      <div class="grid3">
        ${inp('yemot_system', 'מספר המערכת בימות המשיח')}
        ${inp('yemot_password', 'סיסמת המערכת', 'password', 'autocomplete="new-password"')}
        ${inp('yemot_template_id', 'מספר תבנית קמפיין')}
        ${inp('yemot_ivr_path', 'שלוחת התפריט (ברירת מחדל 9)')}
        ${inp('yemot_caller_id', 'מספר מזוהה יוצא (לא חובה)')}
        ${inp('nedarim_target', 'הקשה 1 – מספר / שלוחה של נדרים פלוס (ברירת מחדל)')}
      </div>
      <div class="row"><button type="button" class="btn" id="ymSetup">בדיקת חיבור והתקנת השלוחה</button>
        <input type="text" id="ymPhone" placeholder="הטלפון שלך לבדיקה" style="width:180px"><button type="button" class="btn" id="ymTest">שיחת בדיקה</button>
        <button type="button" class="btn primary" id="ymWarm" title="שיחה אחת מכל סוג הודעה – כדי שימות המשיח יכינו מראש את החלקים הקבועים, ואצל כולם ההודעה תתחיל מיד">🔥 שיחות חימום – כל סוגי ההודעות</button></div>
      <div class="field" style="margin-top:12px"><label>נוסח ברירת מחדל להודעה (כל סוג קובץ יכול לקבל נוסח משלו)</label><textarea name="phone_message">${esc(s.phone_message || '')}</textarea></div>
      <p class="small muted">שיחות יוצאות רק בימים א'–ה' בין 9:00 ל-20:00. מי שכבר שילם לא יקבל שיחה.</p>
    </div>
    <div class="card"><h2>גיבוי וייצוא</h2>
      <p class="small muted">המערכת שומרת גיבוי אוטומטי יומי של מסד הנתונים בתיקייה data/backups (30 אחרונים). מומלץ גם להוריד גיבוי מדי פעם ולשמור מחוץ לשרת.</p>
      <div class="row"><a class="btn" href="/api/export.xlsx">ייצוא כל הנתונים ל-Excel</a><a class="btn" href="#/report">🖨️ דוח מסודר כ-PDF</a><a class="btn" href="/api/backup">הורדת גיבוי מלא של מסד הנתונים</a></div>
    </div>
    <div class="row" style="margin:16px 0"><button class="btn primary">שמירת הגדרות</button></div>
    </form>`);
  bindShell();
  const prep = () => {
    document.getElementById('voiceDays').value = [...document.querySelectorAll('[data-day]')].filter((c) => c.checked).map((c) => c.dataset.day).join(',');
    document.getElementById('tabIcons').value = JSON.stringify(Object.fromEntries([...document.querySelectorAll('[data-icon]')].filter((i) => i.value.trim()).map((i) => [i.dataset.icon, i.value.trim()])));
  };
  const save = () => { prep(); return api('PUT', '/api/settings', formData(document.getElementById('sf'))).then(async (r) => { const me = await api('GET', '/api/me'); state.tabIcons = me.tabIcons || {}; return r; }); };
  document.getElementById('favFile').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 300000) return toast('הקובץ גדול מדי (עד 300KB)', true);
    const rd = new FileReader();
    rd.onload = async () => { try { await api('POST', '/api/settings/favicon', { data_url: rd.result }); setFavicon(true); toast('הסמל עודכן'); renderSettings(); } catch (err) { toast(err.message, true); } };
    rd.readAsDataURL(f);
  };
  const fd2 = document.getElementById('favDel'); if (fd2) fd2.onclick = async () => { await api('POST', '/api/settings/favicon', { data_url: '' }); setFavicon(true); renderSettings(); };
  // סידור לפי קטגוריות: תפריט בצד + חיפוש בכל ההגדרות
  const CATS = [
    ['general', '⚙️ כללי ומראה', ['כללי', 'מראה ותצוגה', 'סמלים']],
    ['texts', '📝 נוסחי ההודעות', ['נוסחי ההודעות']],
    ['phone', '📞 טלפון ושיחות', ['המוקד הטלפוני', 'שליחה חכמה', 'הודעות קוליות – ימות המשיח']],
    ['times', '🕯️ זמנים, שבת וחג', ['זמני שליחת', 'שבת וחג']],
    ['auto', '🤖 אוטומציות ותזכורות', ['הודעה חודשית', 'התראה על אמצעי תשלום', 'שעות התזכורות']],
    ['stt', '🎙️ תמלול', ['תמלול']],
    ['security', '🔑 כניסה ואבטחה', ['דרכי כניסה', 'אבטחה']],
    ['mail', '✉️ מייל', ['שירות מייל', 'SMTP']],
    ['backup', '💾 גיבוי וייצוא', ['גיבוי וייצוא']],
  ];
  const form = document.getElementById('sf');
  const cards = [...form.querySelectorAll(':scope > .card')];
  const catOf = (c) => { const t = (c.querySelector('h2') || {}).textContent || ''; const f = CATS.find(([, , keys]) => keys.some((k) => t.includes(k))); return f ? f[0] : 'general'; };
  cards.forEach((c) => (c.dataset.cat = catOf(c)));
  const wrap = document.createElement('div'); wrap.className = 'set-layout';
  const nav = document.createElement('nav'); nav.className = 'set-nav';
  nav.innerHTML = CATS.map(([k, l]) => `<button type="button" data-cat="${k}">${l}<span class="cnt">${cards.filter((c) => c.dataset.cat === k).length}</span></button>`).join('');
  form.parentNode.insertBefore(wrap, form); wrap.appendChild(nav); wrap.appendChild(form);
  const show = (k) => { state.setCat = k; nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.cat === k)); cards.forEach((c) => (c.hidden = c.dataset.cat !== k)); };
  nav.querySelectorAll('button').forEach((b) => (b.onclick = () => { document.getElementById('setQ').value = ''; show(b.dataset.cat); window.scrollTo(0, 0); }));
  show(state.setCat || 'general');
  document.getElementById('setQ').oninput = (e) => {
    const q = e.target.value.trim();
    if (!q) return show(state.setCat || 'general');
    nav.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    cards.forEach((c) => (c.hidden = !c.textContent.includes(q) && ![...c.querySelectorAll('input,textarea,select')].some((i) => String(i.value || '').includes(q))));
  };
  document.getElementById('sf').onsubmit = async (e) => { e.preventDefault(); try { await save(); toast('ההגדרות נשמרו'); renderSettings(); } catch (err) { toast(err.message, true); } };
  document.getElementById('testMail').onclick = async () => {
    try { await save(); await api('POST', '/api/settings/test-email', { to: document.getElementById('testTo').value }); toast('מייל הבדיקה נשלח – השליחה הופעלה'); renderSettings(); } catch (err) { toast(err.message, true); }
  };
  document.getElementById('ymSetup').onclick = async (e) => {
    e.target.disabled = true;
    try { await save(); const r = await api('POST', '/api/yemot/setup'); toast(`מחובר${r.session.name ? ' ל' + r.session.name : ''}${r.session.units != null ? ' · יחידות: ' + r.session.units : ''}. השלוחה ${r.ivr.path} הותקנה`); renderSettings(); }
    catch (err) { e.target.disabled = false; toast(err.message, true); }
  };
  document.getElementById('ymTest').onclick = async () => {
    try { await save(); await api('POST', '/api/yemot/test-call', { phone: document.getElementById('ymPhone').value }); toast('שיחת בדיקה נשלחה – הטלפון יצלצל בעוד רגע'); } catch (err) { toast(err.message, true); }
  };
  document.getElementById('ymWarm').onclick = async (e) => {
    const phone = document.getElementById('ymPhone').value.trim();
    if (!phone) { toast('כתבו קודם את מספר הטלפון שלכם בשדה שליד הכפתור', true); return; }
    try {
      const d = await api('GET', '/api/yemot/warmup');
      if (!confirm(`יישלחו ${d.items.length} שיחות חימום ל-${phone}, אחת אחרי השנייה:\n\n• ${d.items.join('\n• ')}\n\nכל שיחה עולה יחידות כמו שיחה רגילה. להמשיך?`)) return;
      e.target.disabled = true;
      const r = await api('POST', '/api/yemot/warmup', { phone });
      toast(`${r.count} שיחות חימום נכנסו לתור – ${r.window.label}`);
    } catch (err) { e.target.disabled = false; toast(err.message, true); }
  };
  const dm = document.getElementById('disMail'); if (dm) dm.onclick = async () => { await api('POST', '/api/settings/disable-email'); renderSettings(); };
}


// לפני שליחה: אם יש בהודעה חלקים שימות עוד לא הקריאו – מציעים קודם שיחת חימום לטלפון שלי.
// מחזיר {} לשליחה רגילה, { wait_for } לשליחה אחרי החימום, או null לביטול
async function warmGate(selector) {
  let chk; try { chk = await api('POST', '/api/voice/warm-check', selector); } catch (_) { return {}; }
  if (!chk.cold) return {};
  return new Promise((resolve) => {
    const m = modal(`<h2>🔥 חלק מההודעה חדש אצל ימות המשיח</h2>
      <p>ימות המשיח עוד לא הקריאו אף פעם ${chk.cold === 1 ? 'חלק אחד' : chk.cold + ' חלקים'} מההודעה הזאת. בלי חימום, <b>ייתכן שקט של כמה שניות</b> בתחילת השיחה אצל האדם.</p>
      <div class="small muted" style="background:var(--surface-2);border-radius:8px;padding:8px 12px;margin-bottom:12px">למשל: ${chk.examples.map((x) => '"' + esc(x.length > 70 ? x.slice(0, 70) + '…' : x) + '"').join(' · ')}</div>
      <p class="small">שיחת חימום = שיחה קצרה <b>לטלפון שלך</b> עם אותה הודעה (עם השם שלך). מומלץ לענות ולשמוע עד הסוף. ההודעה לאנשים תצא <b>אוטומטית מיד אחרי</b> החימום.</p>
      <div class="field"><label>הטלפון שלך לשיחת החימום</label><input type="tel" name="phone" value="${esc(chk.myPhone || '')}" placeholder="05X-XXXXXXX"></div>
      <div class="modal-actions" style="flex-wrap:wrap"><button class="btn primary" id="wgWarm">🔥 שיחת חימום אליי – ואז לשלוח</button><button class="btn" id="wgSkip">לשלוח בלי חימום</button><button class="btn" id="wgCancel">ביטול</button></div>`);
    const done = (v) => { m.remove(); resolve(v); };
    m.querySelector('#wgCancel').onclick = () => done(null);
    m.querySelector('#wgSkip').onclick = () => done({});
    m.querySelector('#wgWarm').onclick = async (e) => {
      e.target.disabled = true;
      try { const r = await api('POST', '/api/voice/warm-first', { ...selector, phone: m.querySelector('[name=phone]').value }); toast('שיחת חימום יוצאת אליך. ההודעה לאנשים תצא אחריה.'); done({ wait_for: r.warm_id }); }
      catch (err) { e.target.disabled = false; toast(err.message, true); }
    };
  });
}
// ---------- ניתוב ----------
async function route() {
  if (!state.me) return boot();
  const h = location.hash || '#/';
  document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
  try {
    let m;
    if ((m = h.match(/^#\/case\/(\d+)/))) await renderCase(+m[1]);
    else if (h.startsWith('#/cases')) await renderDashboard();
    else if ((m = h.match(/^#\/person\/(\d+)/))) await renderPerson(+m[1]);
    else if (h.startsWith('#/people')) await renderPeople();
    else if (h.startsWith('#/admin') && can('admin_dashboard')) await renderAdminDash();
    else if (h.startsWith('#/control') && can('control')) await renderControl();
    else if (h.startsWith('#/voice')) await renderVoice();
    else if (h.startsWith('#/sources') && isAdmin()) await renderSources();
    else if (h.startsWith('#/workers')) await renderWorkers();
    else if (h.startsWith('#/import') && can('import')) await renderImport();
    else if (h.startsWith('#/automation') && isAdmin()) await renderAutomation();
    else if (h.startsWith('#/settings') && isAdmin()) await renderSettings();
    else if (h.startsWith('#/report') && can('export')) await renderReport();
    else if (h.startsWith('#/today') || !can('control') || (state.prefs && state.prefs.adminHome === 'today')) await renderToday();
    else await renderControl(); // דף הבית: מסך בקרה (למי שיש לו הרשאה)
    window.scrollTo(0, 0);
  } catch (e) {
    if (state.me) toast(e.message, true);
  }
}
document.addEventListener('click', async (e) => {
  if (e.target.id === 'ttsPrev') {
    const b = e.target; b.disabled = true; b.textContent = 'מכין דוגמה…';
    try {
      const r = await fetch('/api/tts/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'שגיאה'); }
      const a = document.getElementById('ttsAudio'); a.src = URL.createObjectURL(await r.blob()); a.style.display = ''; a.play().catch(() => {});
    } catch (err) { toast(err.message, true); }
    b.disabled = false; b.textContent = '▶ השמעת דוגמה (בלי שיחה)'; return;
  }
  if (e.target.id === 'trAll') { e.target.disabled = true; try { const r = await api('POST', '/api/voice/transcribe-all'); toast(r.count ? `מתמלל ${r.count} הקלטות ברקע – זה יכול לקחת כמה דקות` : 'אין הקלטות שמחכות לתמלול'); } catch (err) { e.target.disabled = false; } return; }
  const b = e.target.closest('[data-retr]'); if (!b) return;
  const [kind, id] = b.dataset.retr.split(':');
  b.disabled = true;
  try { await api('POST', `/api/voice/${kind}/${id}/retranscribe`); toast('התמלול התחיל – יופיע תוך דקה-שתיים'); route(); } catch (err) { b.disabled = false; toast(err.message, true); }
});
function setFavicon(has) {
  // תמיד יש סמל: הסמל שהועלה בהגדרות, או סמל ברירת המחדל של המערכת
  let l = document.querySelector('link[rel="icon"]');
  if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); }
  l.removeAttribute('type');
  l.href = '/favicon.ico?v=' + Date.now();
}
async function boot() {
  const r = await api('GET', '/api/me');
  state.orgName = r.orgName || state.orgName;
  state.me = r.user;
  state.tabIcons = r.tabIcons || {};
  state.hebToday = r.hebToday || ''; state.sendBlock = r.sendBlock || null; state.prefs = r.prefs || {};
  applyAccent(state.prefs.accent);
  setFavicon(r.hasFavicon);
  if (!r.user) return renderLogin(r.needsSetup);
  if (!state.stats) state.stats = await api('GET', '/api/stats').catch(() => null);
  route();
}
window.addEventListener('hashchange', route);
window.route = route;
boot();

// ===================== שלב 1: מסכים חדשים =====================
const VOICE_ST = { sending: 'נשלחת עכשיו', queued: 'ממתין לשליחה', sent: 'מחייג…', answered: 'ענה ושמע', no_answer: 'לא נענתה', voicemail: 'תא קולי', replied: 'השאיר תגובה', failed: 'נכשלה', cancelled: 'בוטלה' };
const VOICE_CLS = { queued: 'pill-mid', sent: 'pill-mid', answered: 'pill-ok', no_answer: 'pill-off', voicemail: 'pill-mid', replied: 'pill-ok', failed: 'pill-off', cancelled: 'st-unresolvable' };
const nextDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// תיעוד שיחה: לחיצה על התוצאה, והמערכת קובעת את המעקב הבא
function outcomeDialog(c, done) {
  const phones = [c.phone1, c.phone2, c.phone3].filter(Boolean);
  const m = modal(`<h2>תיעוד שיחה – ${esc(c.full_name || '')}</h2>
    <p class="small muted">${phones.map((p) => `<a class="ltr" href="tel:${esc(p)}">${esc(p)}</a>`).join(' · ') || 'אין טלפון'} · ${money(c.total_amount)}${c.source_name ? ' · ' + esc(c.source_name) : ''}</p>
    <div class="field"><label>מה הייתה תוצאת השיחה?</label><div class="row" id="oc">${Object.entries(OUTCOMES).map(([k, v]) => `<button type="button" class="btn sm" data-o="${k}">${v}</button>`).join('')}</div></div>
    <div id="ocX"></div>
    <div class="field"><label>הערה (לא חובה)</label><textarea name="text" placeholder="לדוגמה: דיברתי איתו, התחייב לשלם את כל החוב בחודש הבא."></textarea></div>
    <div class="modal-actions"><button class="btn primary" id="ok" disabled>שמירה</button><button class="btn" data-close>ביטול</button></div>`, 'wide');
  let sel = null;
  m.querySelectorAll('[data-o]').forEach((b) => (b.onclick = () => {
    sel = b.dataset.o;
    m.querySelectorAll('[data-o]').forEach((x) => x.classList.toggle('primary', x === b));
    const x = m.querySelector('#ocX');
    const hints = { no_answer: 'המערכת תקבע מעקב ליום העבודה הבא. אחרי 3 ניסיונות היא תציע לשלוח הודעה קולית.', updated_method: 'התיק יעבור ל"ממתין" עד אחרי החיוב הבא (ברירת מחדל: 30 יום).', cancel_request: 'המנהל יקבל התראה ויחליט.' };
    if (sel === 'callback') x.innerHTML = `<div class="grid2"><div class="field"><label>מתי לחזור אליו?</label><input type="date" name="date" min="${todayIso()}" value="${nextDays(1)}"></div><div class="field"><label>שעה (לא חובה)</label><input type="time" name="time"></div></div>`;
    else if (sel === 'promised') x.innerHTML = `<div class="field"><label>עד איזה תאריך התחייב לשלם?</label><input type="date" name="date" min="${todayIso()}" value="${nextDays(7)}"></div><p class="small muted">המערכת תבדוק יום עבודה אחד אחרי התאריך.</p>`;
    else if (sel === 'updated_method') x.innerHTML = `<div class="field"><label>מתי לבדוק שהחיוב עבר?</label><input type="date" name="date" min="${todayIso()}" value="${nextDays(30)}"></div>`;
    else if (sel === 'paid') x.innerHTML = `<div class="notice warn">"שילם" סוגר את התיק כ"טופל". יש לסמן רק כשיש אישור שהחוב הוסדר.</div><label class="check"><input type="checkbox" name="confirm_settled"> אני מאשר/ת שהחוב בסך ${money(c.total_amount)} הוסדר</label><br>`;
    else if (sel === 'wrong_number') x.innerHTML = `<div class="field"><label>איזה מספר שגוי?</label><select name="phone">${phones.map((p) => `<option>${esc(p)}</option>`).join('')}</select></div>`;
    else x.innerHTML = hints[sel] ? `<p class="small muted">${hints[sel]}</p>` : '';
    m.querySelector('#ok').disabled = false;
  }));
  m.querySelector('#ok').onclick = async (ev) => {
    ev.target.disabled = true;
    try {
      const r = await api('POST', `/api/cases/${c.id}/outcome`, { outcome: sel, ...formData(m) });
      m.remove(); toast(r.followup ? `נשמר. מעקב הבא: ${fdate(r.followup)}` : 'נשמר'); done && done();
    } catch (e) { ev.target.disabled = false; toast(e.message, true); }
  };
}

function todayRows(list, empty, late) {
  if (!list.length) return `<div class="empty">${empty}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>שם</th><th>טלפון</th><th class="num">סכום</th><th>סוג / סעיף</th><th>${late ? 'היה אמור' : 'שעה'}</th><th>מה סוכם בפעם הקודמת</th><th></th></tr></thead><tbody>
    ${list.map((r) => `<tr class="clickable" data-id="${r.id}"><td><strong>${esc(r.full_name || '')}</strong>${r.attempts ? `<div class="small muted">${r.attempts} ניסיונות</div>` : ''}</td>
      <td class="nowrap">${phone(r.phone1 || r.phone2 || r.phone3)}</td><td class="num">${money(r.total_amount)}</td><td class="small">${esc(srcLabel(r))}</td>
      <td class="nowrap small ${late ? 'overdue' : ''}">${late ? fdate(r.next_followup_date) : esc(r.followup_time || '')}</td>
      <td class="small"><div class="reasons">${esc(r.last_note || (r.status === 'new' ? 'תיק חדש – עדיין לא נוצר קשר' : ''))}</div></td>
      <td onclick="event.stopPropagation()"><button class="btn sm primary" data-call="${r.id}">תיעוד שיחה</button></td></tr>`).join('')}</tbody></table></div>`;
}
async function renderToday() {
  const [d, stats] = await Promise.all([api('GET', '/api/dashboard/me'), api('GET', '/api/stats')]);
  state.stats = stats;
  const all = [...d.today, ...d.late, ...d.fresh];
  const pct = d.month.received ? Math.round(100 * (d.month.resolved || 0) / d.month.received) : 0;
  $app.innerHTML = shell('today', `
    <div class="page-head"><div><h1>היום שלי</h1><p class="sub">שלום ${esc(state.me.full_name)} · ${new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}</p></div>
      <a class="btn" href="#/cases">כל התיקים</a></div>
    <div class="kpis">
      <div class="kpi"><div class="label">לדבר היום</div><div class="value">${d.today.length}</div><div class="hint">לפי מועדי המעקב</div></div>
      <div class="kpi"><div class="label">באיחור</div><div class="value ${d.late.length ? 'overdue' : ''}">${d.late.length}</div><div class="hint">מועד המעקב עבר</div></div>
      <div class="kpi"><div class="label">חדשים – טרם נוצר קשר</div><div class="value">${d.fresh.length}</div><div class="hint">&nbsp;</div></div>
      <div class="kpi"><div class="label">שיחות שתיעדת היום</div><div class="value">${d.callsToday}</div><div class="hint">החודש: ${d.month.resolved || 0} מתוך ${d.month.received || 0} הוסדרו (${pct}%)</div></div>
    </div>
    <div class="card"><h2>לדבר היום (${d.today.length})</h2>${todayRows(d.today, 'אין שיחות מתוכננות להיום')}</div>
    <div class="card"><h2>באיחור (${d.late.length})</h2>${todayRows(d.late, 'אין תיקים באיחור', true)}</div>
    <div class="card"><h2>חדשים – עדיין לא נוצר קשר (${d.fresh.length})</h2>${todayRows(d.fresh, 'אין תיקים חדשים')}</div>`);
  bindShell();
  document.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => { location.hash = '#/case/' + tr.dataset.id; }));
  document.querySelectorAll('[data-call]').forEach((b) => b.addEventListener('click', () => outcomeDialog(all.find((x) => x.id === +b.dataset.call), renderToday)));
}

async function renderAdminDash() {
  const d = await api('GET', '/api/dashboard/admin');
  $app.innerHTML = shell('admin', `
    <div class="page-head"><div><h1>דשבורד מנהל</h1><p class="sub">מצב הטיפול לפי סוג קובץ ולפי מטפל</p></div><a class="btn primary" href="#/import">ייבוא קובץ חודשי</a></div>
    <div class="card"><h2>לפי סוג קובץ</h2>${d.sources.length ? `<div class="table-wrap"><table><thead><tr><th>סוג קובץ</th><th>אחראי</th><th class="num">פתוחים</th><th class="num">סכום פתוח</th><th class="num">באיחור</th><th class="num">ללא מגע 3+ ימים</th><th class="num">אחוז הסדרה</th><th class="num">הוסדר החודש</th></tr></thead><tbody>
      ${d.sources.map((r) => `<tr class="clickable" data-src="${r.id}"><td><strong>${esc(r.name)}</strong><div class="small muted">${KIND[r.kind]}</div></td><td>${esc(r.assignee || '—')}</td><td class="num">${r.open_n || 0}</td><td class="num">${money(r.open_amount)}</td>
        <td class="num ${r.late_n ? 'overdue' : ''}">${r.late_n || 0}</td><td class="num ${r.idle_n ? 'overdue' : ''}">${r.idle_n || 0}</td><td class="num">${r.total_n ? Math.round(100 * (r.resolved_n || 0) / r.total_n) : 0}%</td><td class="num">${money(r.resolved_month)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">עדיין לא הוגדרו סוגי קבצים. <a href="#/sources">הגדרת סוגי קבצים</a></div>'}</div>
    <div class="card"><h2>לפי מטפל</h2><div class="table-wrap"><table><thead><tr><th>מטפל</th><th class="num">תיקים פתוחים</th><th class="num">באיחור</th><th class="num">שיחות היום</th></tr></thead><tbody>
      ${d.workers.map((w) => `<tr class="clickable" data-w="${w.id}"><td><strong>${esc(w.full_name)}</strong></td><td class="num">${w.open_n || 0}</td><td class="num ${w.late_n ? 'overdue' : ''}">${w.late_n || 0}</td><td class="num">${w.calls_today}</td></tr>`).join('')}</tbody></table></div></div>`);
  bindShell();
  document.querySelectorAll('[data-src]').forEach((tr) => tr.addEventListener('click', () => { state.source = tr.dataset.src; state.assignee = ''; state.view = 'open'; location.hash = '#/cases'; }));
  document.querySelectorAll('[data-w]').forEach((tr) => tr.addEventListener('click', () => { state.assignee = tr.dataset.w; state.source = ''; state.view = 'open'; location.hash = '#/cases'; }));
}

async function renderSources() {
  await Promise.all([loadSources(), loadUsers()]);
  $app.innerHTML = shell('sources', `
    <div class="page-head"><div><h1>סוגי קבצים</h1><p class="sub">כל סוג קובץ חודשי מקבל אחראי קבוע. תיקים חדשים משויכים אליו אוטומטית בייבוא.</p></div><button class="btn primary" id="addS">הוספת סוג קובץ</button></div>
    ${state.sources.length ? `<div class="table-wrap"><table><thead><tr><th>שם</th><th>סוג מעקב</th><th>אחראי</th><th class="num">תיקים פתוחים</th><th class="num">סכום פתוח</th><th>מיפוי עמודות</th><th></th></tr></thead><tbody>
      ${state.sources.map((x) => `<tr ${x.active ? '' : 'style="opacity:.55"'}><td><strong>${esc(x.name)}</strong></td><td>${KIND[x.kind]}</td><td>${esc(x.assignee_name || '—')}</td><td class="num">${x.open_cases}</td><td class="num">${money(x.open_amount)}</td>
        <td class="small">${x.mapping_json ? '<span class="badge pill-ok">נשמר</span>' : '<span class="muted">ייקבע בייבוא הראשון</span>'}</td>
        <td class="nowrap"><button class="btn sm" data-ed="${x.id}">עריכה</button> <button class="btn sm" data-act="${x.id}" data-v="${x.active ? 0 : 1}">${x.active ? 'השבתה' : 'הפעלה'}</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="notice info">עדיין אין סוגי קבצים. הוסיפו סוג לכל קובץ חודשי (למשל "שכר לימוד ישיבה", "מעלים בקודש", "חסרי אמצעי תשלום").</div>'}`);
  bindShell();
  document.getElementById('addS').onclick = () => sourceDialog();
  document.querySelectorAll('[data-ed]').forEach((b) => b.addEventListener('click', () => sourceDialog(state.sources.find((x) => x.id === +b.dataset.ed))));
  document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => { await api('POST', `/api/sources/${b.dataset.act}/active`, { active: b.dataset.v === '1' }); renderSources(); }));
}
function sourceDialog(x) {
  const extra = x && x.extra_users ? x.extra_users.split(',').map(Number) : [];
  let c = {}; try { c = x && x.config_json ? JSON.parse(x.config_json) : {}; } catch (_) { c = {}; }
  const v = (k, d = '') => esc(c[k] != null ? c[k] : d);
  const chk = (k, d) => ((c[k] != null ? c[k] : d) ? 'checked' : '');
  const m = modal(`<h2>${x ? 'עריכת מוסד / סוג קובץ' : 'מוסד / סוג קובץ חדש'}</h2>
    <div class="grid2">
      <div class="field"><label>שם *</label><input type="text" name="name" value="${esc(x ? x.name : '')}" placeholder="החזרות ישיבה"></div>
      <div class="field"><label>סוג מעקב</label><select name="kind"><option value="returns">החזרות חיובים (יש סכום)</option><option value="payment_methods" ${x && x.kind === 'payment_methods' ? 'selected' : ''}>מעקב אמצעי תשלום (חסר / פג תוקף)</option></select></div>
      <div class="field"><label>אחראי קבוע</label><select name="default_assignee_id">${userOptions(x ? x.default_assignee_id : '', { noneLabel: '— ללא —' })}</select></div>
      <div class="field"><label>שם המוסד כפי שיוקרא בטלפון</label><input type="text" data-c="institution" value="${v('institution')}" placeholder="ישיבת נתיבות שלום סלונים"></div>
    </div>
    ${x ? '<label class="check"><input type="checkbox" name="move_open_cases"> להעביר גם את התיקים הפתוחים לאחראי שנבחר</label><br>' : ''}
    <div class="field"><label>עובדים נוספים שיראו את התיקים, ההודעות וההקלטות של המוסד</label><div class="row">${state.users.filter((u) => u.active).map((u) => `<label class="check"><input type="checkbox" data-xu="${u.id}" ${extra.includes(u.id) ? 'checked' : ''}> ${esc(u.full_name)}</label>`).join('')}</div></div>
    <h3>תפריט טלפוני של המוסד</h3>
    <p class="small muted">אפשר להשתמש ב-[מוסד] ו-[הקשה]. מספר ריק = המספר הכללי מההגדרות.</p>
    <div class="grid3">
      <div class="field"><label>טלפון המשרד לניתוב</label><input type="text" data-c="office_phone" value="${v('office_phone')}" placeholder="025804581"></div>
      <div class="field"><label>הקשה למעבר למשרד</label><input type="text" data-c="office_digit" value="${v('office_digit', '2')}" maxlength="1"></div>
      <div class="field"><label>הקשה בתפריט הראשי (למתקשר לא מזוהה)</label><input type="text" data-c="main_digit" value="${v('main_digit')}" maxlength="1" placeholder="ריק = לא מופיע"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>נוסח אפשרות המעבר למשרד</label><input type="text" data-c="office_option" value="${v('office_option', 'למשרדי [מוסד] הקישו [הקשה].')}"></div>
      <div class="field"><label>מה נאמר בזמן הניתוב</label><input type="text" data-c="transfer_text" value="${v('transfer_text', 'מעביר אותך למשרדי [מוסד].')}"></div>
      <div class="field"><label>נוסח בתפריט הראשי</label><input type="text" data-c="main_option" value="${v('main_option', 'לענייני [מוסד] הקישו [הקשה].')}"></div>
      <div class="field"><label>פתיח לפני ההודעה (לא חובה)</label><input type="text" data-c="greeting" value="${v('greeting')}" placeholder="שלום וברכה, כאן משרדי הישיבה."></div>
    </div>
    <h3 style="margin-top:8px">ניתוב לפי שעות</h3>
    <p class="small muted">בימים ובשעות שמוגדרים כאן, מי שמקיש למעבר למשרד יועבר ישירות לאדם שנבחר. מחוץ לשעות – לטלפון המשרד. הכלל הראשון שמתאים הוא שקובע.</p>
    <div id="rules"></div>
    <button type="button" class="btn sm" id="addRule">הוספת כלל ניתוב</button>
    <div style="height:10px"></div>
    <label class="check"><input type="checkbox" data-c="allow_record" ${chk('allow_record', true)}> אפשרות להשאיר הודעה קולית (ההודעה נשמרת ומשויכת למוסד ולאחראי)</label>
    <h3 style="margin-top:12px">נוסחי ההודעה של המוסד (ריק = הנוסח הכללי מההגדרות)</h3>
    <p class="small muted">משתנים: [שם] [סכום] [סעיף] [מספר] [מוסד]</p>
    <div class="field"><label>הוראה אחת</label><textarea data-c="msg_single" rows="2">${v('msg_single')}</textarea></div>
    <div class="field"><label>כמה הוראות לאותו אדם</label><textarea data-c="msg_multi" rows="2">${v('msg_multi')}</textarea></div>
    <div class="field"><label>משפט הבקשה בסוף ההודעה – במקום "נשמח שתסדיר את התשלום בהקדם" (ריק = הנוסח הרגיל)</label><input type="text" data-c="closing_text" value="${esc(c.closing_text != null ? c.closing_text : (/תרומ/.test(x ? x.name : '') ? 'נשמח מאוד שתמשיך לקחת חלק בהחזקת המוסדות על ידי עדכון אמצעי תשלום.' : ''))}" placeholder="למשל: נשמח מאוד שתמשיך לקחת חלק בהחזקת המוסדות על ידי עדכון אמצעי תשלום."></div>
    <h3>תזכורות אוטומטיות כשאין התקדמות</h3>
    <label class="check"><input type="checkbox" data-c="reminders_enabled" ${chk('reminders_enabled', false)}> מופעל</label>
    <div class="grid3">
      <div class="field"><label>לשלוח תזכורת אחרי (ימים)</label><input type="number" data-c="reminder_days" min="1" max="60" value="${v('reminder_days', 5)}"></div>
      <div class="field"><label>כמה תזכורות לכל היותר</label><input type="number" data-c="reminder_max" min="1" max="10" value="${v('reminder_max', 2)}"></div>
      <div class="field"><label>לספור את הימים מ-</label><select data-c="reminder_base"><option value="manual">ההודעה האחרונה שנשלחה</option><option value="action" ${c.reminder_base === 'action' ? 'selected' : ''}>הטיפול האחרון בתיק</option></select></div>
    </div>
    <div class="field"><label>נוסח לכל תזכורת (שורה לכל תזכורת: שורה 1 = תזכורת ראשונה...). ריק = נוסח כללי</label><textarea data-c="reminder_texts" rows="3">${esc((c.reminder_texts || []).join('\n'))}</textarea></div>
    <p class="small muted">תזכורת לא תישלח אם עובד תיעד שיחה או פעולה, נקבע מעקב עתידי, האדם הגיב בטלפון, או שההוראה הוסדרה.</p>
    <div class="modal-actions"><button class="btn primary" id="ok">שמירה</button><button class="btn" data-close>ביטול</button></div>`, 'wide');
  // עורך כללי הניתוב
  const dayN = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
  const rules = (Array.isArray(c.routing_rules) ? c.routing_rules : []).map((r) => ({ ...r }));
  const drawRules = () => {
    m.querySelector('#rules').innerHTML = rules.map((r, i) => `<div class="card" style="padding:10px;margin-bottom:8px" data-rule="${i}">
      <div class="grid3">
        <div class="field"><label>עובד (ממלא שם וטלפון)</label><select data-rw="${i}"><option value="">— בחירה —</option>${state.users.filter((u) => u.active).map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}</select></div>
        <div class="field"><label>שם שיוקרא ("מעביר אותך ל...")</label><input type="text" data-rf="label" data-i="${i}" value="${esc(r.label || '')}"></div>
        <div class="field"><label>טלפון</label><input type="text" data-rf="phone" data-i="${i}" value="${esc(r.phone || '')}"></div>
      </div>
      <div class="row">${dayN.map((n, di) => `<label class="check"><input type="checkbox" data-rd="${i}" value="${di}" ${String(r.days == null ? '0,1,2,3,4' : r.days).split(',').includes(String(di)) ? 'checked' : ''}> ${n}</label>`).join('')}
        <label class="small" style="margin:0">משעה</label><input type="time" data-rf="from" data-i="${i}" value="${esc(r.from || '09:00')}" style="width:auto">
        <label class="small" style="margin:0">עד</label><input type="time" data-rf="to" data-i="${i}" value="${esc(r.to || '13:00')}" style="width:auto">
        <button type="button" class="btn sm danger" data-rdel="${i}">מחיקה</button></div></div>`).join('') || '<p class="small muted">אין כללים – כל השיחות מגיעות לטלפון המשרד.</p>';
    m.querySelectorAll('[data-rf]').forEach((el) => (el.oninput = () => (rules[+el.dataset.i][el.dataset.rf] = el.value)));
    m.querySelectorAll('[data-rd]').forEach((el) => (el.onchange = () => { const i = +el.dataset.rd; rules[i].days = [...m.querySelectorAll(`[data-rd="${i}"]`)].filter((x) => x.checked).map((x) => x.value).join(','); }));
    m.querySelectorAll('[data-rdel]').forEach((b) => (b.onclick = () => { rules.splice(+b.dataset.rdel, 1); drawRules(); }));
    m.querySelectorAll('[data-rw]').forEach((el) => (el.onchange = () => { const u = state.users.find((x) => x.id === +el.value); if (!u) return; const i = +el.dataset.rw; rules[i].label = u.full_name; if (u.phone) rules[i].phone = u.phone; else toast('לעובד הזה לא מוגדר טלפון – הקלידו אותו', true); drawRules(); }));
  };
  m.querySelector('#addRule').onclick = () => { rules.push({ days: '0,1,2,3,4', from: '09:00', to: '13:00' }); drawRules(); };
  drawRules();
  m.querySelector('#ok').onclick = async (ev) => {
    const d = formData(m);
    d.extra_user_ids = [...m.querySelectorAll('[data-xu]')].filter((cb) => cb.checked).map((cb) => +cb.dataset.xu);
    d.config = Object.fromEntries([...m.querySelectorAll('[data-c]')].map((el) => [el.dataset.c, el.type === 'checkbox' ? el.checked : el.value.trim()]));
    d.config.routing_rules = rules.filter((r) => r.phone);
    if (x) { d.voice_message = x.voice_message; d.nedarim_target = x.nedarim_target; d.callback_days = x.callback_days; d.callback_phone = x.callback_phone; }
    ev.target.disabled = true;
    try { await api(x ? 'PUT' : 'POST', x ? `/api/sources/${x.id}` : '/api/sources', d); m.remove(); toast('נשמר'); renderSources(); } catch (e) { ev.target.disabled = false; toast(e.message, true); }
  };
}
async function renderVoice() {
  const [d, unk] = await Promise.all([api('GET', '/api/voice'), api('GET', '/api/voice/unknown').catch(() => []), loadSources()]);
  const unkOpen = (unk || []).filter((m) => !m.handled);
  const connected = d.status.state !== 'not_configured';
  const replies = d.calls.filter((v) => (v.status === 'replied' || v.recording_url) && !v.handled);
  $app.innerHTML = shell('voice', `
    <div class="page-head"><div><h1>הודעות קוליות</h1><p class="sub">מי קיבל הודעה, מה הקיש, ומי השאיר תגובה</p></div>
      ${can('send_voice') ? `<div class="row"><select id="vSrc" class="inline-select">${state.sources.filter((x) => x.active).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select><button class="btn primary" id="vBulk">שליחה לכל התיקים החדשים בסוג</button></div>` : ''}</div>
    ${connected ? `<div class="notice info">${esc(d.status.label)}</div>` : `<div class="notice warn"><strong>שירות החיוג עדיין לא מחובר.</strong> בקשות שליחה נשמרות בתור, אבל לא מתבצעת שום שיחה עד לחיבור ספק (למשל ימות המשיח).</div>`}
    ${unkOpen.length ? `<div class="card"><h2>הודעות ממספרים שאין להם תיק (${unkOpen.length})</h2><div class="table-wrap"><table><thead><tr><th>מתי</th><th>טלפון</th><th>מוסד</th><th>תמלול</th><th>הקלטה</th><th></th></tr></thead><tbody>
      ${unkOpen.map((m) => `<tr><td class="small nowrap">${fdate(m.created_at)}</td><td><span class="ltr">${esc(m.phone)}</span></td><td class="small">${esc(m.source_name || '—')}</td>
        <td class="small" style="max-width:320px">${transcriptCell(m, 'unknown')}</td>
        <td>${can('listen_recordings') && (m.recording_url || m.local_file) ? `<audio controls preload="none" src="/api/voice/unknown/${m.id}/recording" style="height:32px;max-width:200px"></audio>` : ''}</td><td><button class="btn sm" data-uh="${m.id}">טופל</button></td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${replies.length ? `<div class="card"><h2>תגובות שלא טופלו (${replies.length})</h2>${voiceTable(replies)}</div>` : ''}
    ${(() => {
      // כל ההודעות שאנשים השאירו – גם אלה שכבר טופלו, גם ממספרים לא מוכרים
      const all = [
        ...d.calls.filter((v) => v.recording_url || v.local_file || v.transcript).map((v) => ({ when: v.updated_at || v.created_at, who: v.contact_id ? `<a href="#/person/${v.contact_id}">${esc(v.full_name || '')}</a>` : esc(v.full_name || ''), phone: v.phone, src: v.source_name, tr: transcriptCell(v, 'call'), audio: `/api/voice/${v.id}/recording`, handled: v.handled })),
        ...(unk || []).map((m) => ({ when: m.created_at, who: '<span class="muted">מספר לא מוכר</span>', phone: m.phone, src: m.source_name, tr: transcriptCell(m, 'unknown'), audio: (m.recording_url || m.local_file) ? `/api/voice/unknown/${m.id}/recording` : '', handled: m.handled })),
      ].sort((a, b) => String(b.when).localeCompare(String(a.when)));
      return `<div class="card"><h2>כל ההודעות שהשאירו (${all.length})</h2>${all.length ? `<div class="table-wrap"><table><thead><tr><th>מתי</th><th>מי</th><th>טלפון</th><th>מוסד</th><th>תמלול</th><th>הקלטה</th><th>מצב</th></tr></thead><tbody>
        ${all.map((r) => `<tr><td class="small nowrap">${fdate(r.when)}</td><td>${r.who}</td><td><span class="ltr">${esc(r.phone || '')}</span></td><td class="small">${esc(r.src || '—')}</td>
          <td class="small" style="max-width:340px">${r.tr}</td><td>${can('listen_recordings') && r.audio ? `<audio controls preload="none" src="${r.audio}" style="height:32px;max-width:200px"></audio>` : ''}</td>
          <td>${r.handled ? '<span class="badge st-resolved">טופל</span>' : '<span class="badge pill-mid">ממתין</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">עדיין לא השאירו הודעות</div>'}</div>`;
    })()}
    <div class="card"><h2>כל ההודעות (${d.calls.length})</h2>
      ${(() => { const c = (k) => d.calls.filter((v) => v.status === k).length; return `<div class="row small" style="margin-bottom:10px">
        ${[
          ['pill-ok', `ענו: ${c('answered') + c('replied')}`, { vst: 'answered_any' }], ['pill-ok', `שמעו הכל: ${d.calls.filter((v) => v.listen_status === 'full').length}`, { vls: 'full' }],
          ['pill-mid', `שמעו חלק: ${d.calls.filter((v) => v.listen_status === 'partial').length}`, { vls: 'partial' }], ['pill-off', `ניתקו בהתחלה: ${d.calls.filter((v) => v.listen_status === 'early').length}`, { vls: 'early' }],
          ['pill-off', `לא ענו: ${c('no_answer')}`, { vst: 'no_answer' }], ['pill-mid', `מחייג / ממתין: ${c('sent') + c('queued') + c('sending')}`, { vst: 'pending_any' }], ['pill-off', `נכשלו: ${c('failed')}`, { vst: 'failed' }],
          ['st-in_progress', `השאירו הודעה: ${d.calls.filter((v) => v.digit_pressed === '1').length}`, { vdg: '1' }], ['st-new', `עברו למשרד: ${d.calls.filter((v) => v.digit_pressed === '2').length}`, { vdg: '2' }],
        ].map(([cls, label, f]) => `<button type="button" class="badge ${cls} vfilter" data-f='${JSON.stringify(f)}' title="להציג רק את אלה">${label}</button>`).join('')}</div>`; })()}
      <div class="toolbar">
        <input type="search" id="vq" class="search" placeholder="חיפוש: שם, טלפון, מזהה או מילה מהתמלול" value="${esc(state.vq || '')}">
        <select id="vst" class="inline-select"><option value="">כל המצבים</option><option value="answered_any" ${state.vst === 'answered_any' ? 'selected' : ''}>ענו (כולל השאירו תגובה)</option><option value="pending_any" ${state.vst === 'pending_any' ? 'selected' : ''}>מחייג / ממתין</option>${Object.entries(VOICE_ST).map(([k, l]) => `<option value="${k}" ${state.vst === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="vtr" class="inline-select"><option value="">כל סוגי ההודעות</option>${Object.entries(TRIGGER).map(([k, l]) => `<option value="${k}" ${state.vtr === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="vls" class="inline-select"><option value="">כל ההאזנות</option>${[['full', 'שמע הכל'], ['partial', 'שמע חלק'], ['early', 'ניתק בהתחלה']].map(([k, l]) => `<option value="${k}" ${state.vls === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="vdg" class="inline-select"><option value="">כל ההקשות</option><option value="1" ${state.vdg === '1' ? 'selected' : ''}>השאיר הודעה</option><option value="2" ${state.vdg === '2' ? 'selected' : ''}>עבר למשרד</option><option value="none" ${state.vdg === 'none' ? 'selected' : ''}>לא הקיש</option></select>
        <select id="vsr" class="inline-select"><option value="">כל סוגי הקבצים</option>${[...new Map(d.calls.filter((v) => v.source_id).map((v) => [v.source_id, v.source_name])).entries()].map(([id, n]) => `<option value="${id}" ${String(id) === state.vsr ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
        <label class="small" style="margin:0">מתאריך</label><input type="date" id="vfrom" value="${esc(state.vfrom || '')}" style="width:auto">
        <label class="small" style="margin:0">עד</label><input type="date" id="vto" value="${esc(state.vto || '')}" style="width:auto">
        <button class="btn sm" id="vclr">ניקוי</button>
      </div>
      <div id="vlist"></div></div>`);
  bindShell();
  const drawList = () => {
    const q = (state.vq || '').trim().toLowerCase().replace(/[-\s]/g, '');
    const list = d.calls.filter((v) => {
      if (q && ![v.full_name, v.phone, v.external_id, v.transcript].some((x) => String(x || '').toLowerCase().replace(/[-\s]/g, '').includes(q))) return false;
      if (state.vst === 'answered_any' ? !['answered', 'replied'].includes(v.status) : state.vst === 'pending_any' ? !['sent', 'queued', 'sending'].includes(v.status) : state.vst && v.status !== state.vst) return false;
      if (state.vtr && v.trigger !== state.vtr) return false;
      if (state.vls && v.listen_status !== state.vls) return false;
      if (state.vdg === 'none' ? v.digit_pressed : state.vdg && v.digit_pressed !== state.vdg) return false;
      if (state.vsr && String(v.source_id) !== state.vsr) return false;
      const day = String(v.created_at).slice(0, 10);
      if (state.vfrom && day < state.vfrom) return false;
      if (state.vto && day > state.vto) return false;
      return true;
    });
    const shown = list.slice(0, 300);
    document.getElementById('vlist').innerHTML = !d.calls.length ? '<div class="empty">עדיין לא נשלחו הודעות</div>' : !list.length ? '<div class="empty">לא נמצאו הודעות לפי החיפוש</div>'
      : `<p class="small muted">${list.length} תוצאות${list.length > 300 ? ' (מוצגות 300 הראשונות – צמצמו את החיפוש)' : ''}</p>${voiceTable(shown)}`;
    document.querySelectorAll('#vlist [data-vh]').forEach((b) => b.addEventListener('click', async () => { await api('POST', `/api/voice/${b.dataset.vh}/handled`); renderVoice(); }));
    document.querySelectorAll('#vlist [data-vx]').forEach((b) => b.addEventListener('click', async () => { await api('DELETE', `/api/voice/${b.dataset.vx}`); renderVoice(); }));
  };
  let vt;
  document.getElementById('vq').oninput = (e) => { clearTimeout(vt); vt = setTimeout(() => { state.vq = e.target.value; drawList(); }, 200); };
  [['vst', 'vst'], ['vtr', 'vtr'], ['vls', 'vls'], ['vdg', 'vdg'], ['vsr', 'vsr'], ['vfrom', 'vfrom'], ['vto', 'vto']].forEach(([id, k]) => (document.getElementById(id).onchange = (e) => { state[k] = e.target.value; drawList(); }));
  // לחיצה על תגית צבעונית / על סוג ההודעה / על המוסד = סינון לפיהם
  const applyFilter = (f) => { Object.assign(state, { vst: '', vls: '', vdg: '', vtr: '', vsr: '' }, f); renderVoice().then(() => { const l = document.getElementById('vlist'); if (l) l.scrollIntoView({ behavior: 'smooth', block: 'start' }); }); };
  document.querySelectorAll('.vfilter').forEach((b) => (b.onclick = () => applyFilter(JSON.parse(b.dataset.f))));
  document.getElementById('vlist').addEventListener('click', (e) => { const t = e.target.closest('[data-ftr],[data-fsrc]'); if (!t) return; e.preventDefault(); applyFilter(t.dataset.ftr ? { vtr: t.dataset.ftr } : { vsr: t.dataset.fsrc }); });
  document.getElementById('vclr').onclick = () => { Object.assign(state, { vq: '', vst: '', vls: '', vtr: '', vdg: '', vsr: '', vfrom: '', vto: '' }); renderVoice(); };
  drawList();
  const vb = document.getElementById('vBulk');
  if (vb) vb.onclick = async () => { const sid = document.getElementById('vSrc').value; const g = await warmGate({ source_id: sid }); if (!g) return; try { const r = await api('POST', '/api/voice/bulk', { source_id: sid, ...g }); toast(`${r.queued} הודעות – ${r.window.label}`); setTimeout(renderVoice, 4000); } catch (e) { toast(e.message, true); } };
  document.querySelectorAll('[data-uh]').forEach((b) => b.addEventListener('click', async () => { await api('POST', `/api/voice/unknown/${b.dataset.uh}/handled`); renderVoice(); }));
  document.querySelectorAll('[data-vh]').forEach((b) => { if (!b.closest('#vlist')) b.addEventListener('click', async () => { await api('POST', `/api/voice/${b.dataset.vh}/handled`); renderVoice(); }); });
  document.querySelectorAll('[data-vx]').forEach((b) => { if (!b.closest('#vlist')) b.addEventListener('click', async () => { await api('DELETE', `/api/voice/${b.dataset.vx}`); renderVoice(); }); });
}
function transcriptCell(v, kind) {
  if (!can('listen_recordings')) return '';
  if (v.transcript) return `<div style="white-space:pre-wrap">${esc(v.transcript)}</div>`;
  if (v.transcript_status === 'failed') return `<span class="badge pill-off">התמלול נכשל</span> <button class="btn sm" data-retr="${kind}:${v.id}">ניסיון חוזר</button>`;
  if (v.transcript_status === 'pending') return '<span class="badge pill-mid">מתמלל…</span>';
  return '';
}
// האם שמע את כל ההודעה
function listenBadge(v) {
  if (!v.listen_status) return '';
  const L = { full: ['pill-ok', 'שמע הכל'], partial: ['pill-mid', 'שמע חלק'], early: ['pill-off', 'ניתק בהתחלה'] }[v.listen_status];
  if (!L) return '';
  const pct = v.message_seconds && v.listened_seconds != null ? Math.min(100, Math.round((v.listened_seconds / v.message_seconds) * 100)) : null;
  return `<div style="margin-top:3px"><span class="badge ${L[0]}" title="הקשיב כ-${v.listened_seconds || 0} שניות${v.message_seconds ? ' מתוך כ-' + v.message_seconds : ''}">${L[1]}${pct != null && v.listen_status !== 'full' ? ` · ${pct}%` : ''}</span></div>`;
}
function voiceTable(list) {
  const DIG = (v) => (v.digit_pressed ? (v.recording_url || v.local_file || v.transcript ? 'השאיר הודעה' : 'עבר למשרד') : '');
  return `<div class="table-wrap"><table><thead><tr><th>נשלח</th><th>אדם</th><th>סוג</th><th>אופן</th><th>טלפון</th><th>מצב</th><th>הקשה</th><th>תמלול</th><th>הקלטה</th><th></th></tr></thead><tbody>
    ${list.map((v) => `<tr><td class="nowrap small">${fdate(v.created_at)}${v.sent_by ? `<div class="muted">${esc(v.sent_by)}</div>` : ''}</td><td><a href="#/case/${v.case_id}">${esc(v.full_name)}</a></td><td class="small">${v.source_id ? `<a href="#" data-fsrc="${v.source_id}" title="להציג רק את המוסד הזה">${esc(v.source_name || '')}</a>` : esc(v.source_name || '')}</td>
      <td class="small"><a href="#" data-ftr="${esc(v.trigger || '')}" title="להציג רק את סוג ההודעה הזה">${esc(TRIGGER[v.trigger] || v.trigger || '')}</a>${v.reminder_no ? ' ' + v.reminder_no : ''}${(() => { try { const n = JSON.parse(v.event_ids || '[]').length; return n > 1 ? `<div class="muted">מאוחדת: ${n} הוראות</div>` : ''; } catch (_) { return ''; } })()}</td>
      <td><span class="ltr">${esc(v.phone)}</span></td>
      <td><span class="badge ${VOICE_CLS[v.status] || ''}">${esc(VOICE_ST[v.status] || v.status)}</span>${listenBadge(v)}${v.error ? `<div class="small" style="color:var(--danger)">${esc(v.error)}</div>` : ''}</td><td class="small">${DIG(v)}</td>
      <td class="small" style="max-width:300px">${transcriptCell(v, 'call')}</td>
      <td>${can('listen_recordings') && (v.recording_url || v.local_file) ? `<audio controls preload="none" src="/api/voice/${v.id}/recording" style="height:32px;max-width:200px"></audio>` : ''}</td>
      <td class="nowrap">${(v.status === 'replied' || v.recording_url || v.transcript) && !v.handled ? `<button class="btn sm" data-vh="${v.id}">טופל</button>` : ''}${v.status === 'queued' && can('send_voice') ? `<button class="btn sm danger" data-vx="${v.id}">ביטול</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}


// ---------- הוספה ידנית ----------
function eventFields() {
  return `<div class="grid3">
    <div class="field"><label>סכום (₪)</label><input type="number" name="amount" min="0" step="0.01"></div>
    <div class="field"><label>תאריך</label><input type="date" name="date" value="${todayIso()}"></div>
    <div class="field"><label>סעיף / סיווג תרומה</label><input type="text" name="charge_item" placeholder="למשל: שכר לימוד"></div>
    <div class="field"><label>אמצעי תשלום</label><input type="text" name="payment_method" list="pmList" placeholder="למשל: מזומן"><datalist id="pmList"><option>מזומן</option><option>צ'ק</option><option>אשראי</option><option>הוראת קבע</option><option>העברה בנקאית</option></datalist></div>
    <div class="field"><label>סיבה / הערה</label><input type="text" name="reason" placeholder="למשל: צ'ק חזר"></div>
    <div class="field"><label>אסמכתא (לא חובה)</label><input type="text" name="reference"></div>
  </div>`;
}
async function manualDialog() {
  await Promise.all([loadSources(), loadUsers()]);
  const m = modal(`<h2>הוספת תיק ידנית</h2>
    <p class="small muted">לחיוב שלא הגיע מקובץ Excel – למשל מזומן או צ'ק שחזר. אם המזהה כבר קיים, החיוב יתווסף לתיק הפתוח של אותו אדם.</p>
    <h3>פרטי האדם</h3>
    <div class="grid3">
      <div class="field"><label>שם מלא *</label><input type="text" name="full_name"></div>
      <div class="field"><label>מזהה איש קשר (לא חובה)</label><input type="text" name="external_id" placeholder="ריק = מזהה אוטומטי"></div>
      <div class="field"><label>טלפון</label><input type="text" name="phone1"></div>
      <div class="field"><label>טלפון נוסף</label><input type="text" name="phone2"></div>
      <div class="field"><label>כתובת</label><input type="text" name="address"></div>
      <div class="field"><label>עיר</label><input type="text" name="city"></div>
    </div>
    <h3>סוג העדכון</h3>
    <div class="row" style="margin-bottom:12px">
      <label class="check"><input type="radio" name="update_kind" value="return" checked> החזרת הוראת קבע / חיוב</label>
      <label class="check"><input type="radio" name="update_kind" value="expiry"> פקיעת תוקף אמצעי תשלום</label>
    </div>
    <div id="expf" hidden><div class="grid3">
      <div class="field"><label>סעיף חיוב (על איזו הוראה) *</label><input type="text" name="x_charge_item" placeholder="למשל: תורה הקדושה"></div>
      <div class="field"><label>חודש ושנה של פקיעת התוקף *</label><input type="month" name="x_expiry_month"></div>
      <div class="field"><label>אמצעי תשלום (לא חובה)</label><input type="text" name="x_payment_method" placeholder="למשל: אשראי"></div>
    </div></div>
    <div id="retf"><h3>החיוב</h3>
    <div class="grid2">
      <div class="field"><label>סוג קובץ</label><select name="source_id"><option value="">— ללא —</option>${state.sources.filter((x) => x.active).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field"><label>מטפל (ריק = האחראי של הסוג)</label><select name="assignee_id">${userOptions('', { noneLabel: '— אוטומטי —' })}</select></div>
    </div>
    <div id="evf">${eventFields()}</div></div>
    <div class="modal-actions"><button class="btn primary" id="ok">שמירה</button><button class="btn" data-close>ביטול</button></div>`, 'wide');
  m.querySelectorAll('[name=update_kind]').forEach((r) => (r.onchange = () => { const x = m.querySelector('[name=update_kind]:checked').value === 'expiry'; m.querySelector('#expf').hidden = !x; m.querySelector('#retf').hidden = x; }));
  m.querySelector('#ok').onclick = async (ev) => {
    const all = formData(m);
    const isExp = m.querySelector('[name=update_kind]:checked').value === 'expiry';
    const evf = isExp ? { charge_item: all.x_charge_item, expiry_month: all.x_expiry_month, payment_method: all.x_payment_method } : formData(m.querySelector('#evf'));
    const body = { ...all, update_kind: isExp ? 'expiry' : 'return', event: evf };
    if (isExp) delete body.source_id;
    ev.target.disabled = true;
    try { const r = await api('POST', '/api/cases/manual', body); m.remove(); toast(r.created ? 'התיק נוצר' : 'החיוב נוסף לתיק הקיים'); location.hash = '#/case/' + r.case_id; }
    catch (e) { ev.target.disabled = false; toast(e.message, true); }
  };
}


// ---------- אנשים ----------
async function renderPeople() {
  $app.innerHTML = shell('people', `
    <div class="page-head"><div><h1>אנשי קשר</h1><p class="sub">כל אדם עם כל מה שחזר לו – מכל סוגי הקבצים</p></div></div>
    <div class="toolbar"><input type="search" id="pq" class="search" placeholder="חיפוש: שם, מזהה או טלפון" value="${esc(state.pq || '')}"></div>
    <div id="plist"><div class="empty">טוען…</div></div>`);
  bindShell();
  const load = async () => {
    const rows = await api('GET', '/api/people?q=' + encodeURIComponent(state.pq || ''));
    const el = document.getElementById('plist'); if (!el) return;
    el.innerHTML = !rows.length ? '<div class="empty">לא נמצאו אנשי קשר</div>' : `<div class="table-wrap"><table><thead><tr><th>שם</th><th>מזהה</th><th>טלפון</th><th>סוגי קבצים</th><th class="num">תיקים פתוחים</th><th class="num">סכום פתוח</th><th>מטפלים</th><th class="num">הודעות קוליות</th><th>טיפול אחרון</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="clickable" data-p="${r.id}"><td><strong>${esc(r.full_name || '')}</strong></td><td>${esc(r.external_id)}</td><td><span class="ltr">${esc(r.phone1 || '')}</span></td>
        <td class="small">${esc((r.sources || '').split(',').join(' · '))}</td><td class="num">${r.open_n || 0} / ${r.cases_n}</td><td class="num">${money(r.open_amount)}</td>
        <td class="small">${esc((r.workers || '').split(',').join(' · '))}</td><td class="num">${r.voice_n}</td><td class="small nowrap">${r.last_action ? fdate(r.last_action.slice(0, 10)) : '—'}</td></tr>`).join('')}
      </tbody></table></div><p class="small muted">${rows.length} אנשי קשר${rows.length >= 500 ? ' (מוצגים 500 – צמצמו בחיפוש)' : ''}</p>`;
    el.querySelectorAll('[data-p]').forEach((tr) => tr.addEventListener('click', () => { location.hash = '#/person/' + tr.dataset.p; }));
  };
  let t; document.getElementById('pq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { state.pq = e.target.value; load(); }, 250); };
  load();
}

async function renderPerson(id) {
  if (can('assign') && !state.users) await loadUsers().catch(() => {});
  const d = await api('GET', `/api/people/${id}`);
  const ct = d.contact;
  const open = d.cases.filter((c) => !['resolved', 'unresolvable'].includes(c.status));
  const openAmt = open.reduce((a, c) => a + (c.total_amount || 0), 0);
  const DIG = { 1: 'השאיר הודעה', 2: 'עבר למשרד' };
  $app.innerHTML = shell('people', `
    <div class="page-head"><div><a href="#/people" class="small">→ לכל אנשי הקשר</a><h1>${esc(ct.full_name || '')} ${can('edit_contacts') ? '<button class="btn sm" id="pEdit">עריכת פרטים</button>' : ''}</h1>
      <p class="sub">מזהה ${esc(ct.external_id)} · ${[ct.phone1, ct.phone2, ct.phone3].filter(Boolean).map((p) => `<span class="ltr">${esc(p)}</span>`).join(' · ') || 'אין טלפון'}${ct.city ? ' · ' + esc(ct.city) : ''}</p></div></div>
    <div class="kpis">
      <div class="kpi"><div class="label">תיקים פתוחים</div><div class="value">${open.length}</div><div class="hint">מתוך ${d.cases.length} תיקים</div></div>
      <div class="kpi"><div class="label">סכום פתוח</div><div class="value">${money(openAmt)}</div><div class="hint">${d.events.length} שורות חיוב</div></div>
      <div class="kpi"><div class="label">הודעות קוליות</div><div class="value">${d.voice.length}</div><div class="hint">${d.voice.filter((v) => ['answered', 'replied'].includes(v.status)).length} נענו</div></div>
      <div class="kpi"><div class="label">טיפול אחרון</div><div class="value" style="font-size:20px">${d.actions[0] ? fdate(d.actions[0].created_at.slice(0, 10)) : '—'}</div><div class="hint">${esc(d.actions[0] ? (d.actions[0].user_name || 'מערכת') : '')}</div></div>
    </div>
    ${d.preview && d.preview.count && can('send_voice') ? `<div class="card" style="border:2px solid var(--primary)">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">📞 הודעה קולית אחת על כל מה שפתוח (${d.preview.count} הוראות · ${money(d.preview.total)})</h2>
      <button class="btn primary" id="pSend" ${[ct.phone1, ct.phone2, ct.phone3].some(Boolean) ? '' : 'disabled title="אין טלפון"'}>שליחת הודעה קולית עכשיו</button></div>
      <p class="small muted" style="margin:10px 0 4px">זה מה שהוא ישמע:</p><div style="background:var(--surface-2);border-radius:8px;padding:12px;white-space:pre-wrap">${esc(d.preview.text)}</div>
      ${d.preview.queued ? '<p class="small" style="color:var(--warn);margin:8px 0 0">כבר יש לו הודעה שממתינה לשליחה.</p>' : ''}</div>` : ''}
    <div class="card"><h2>התיקים שלו – עריכה מהירה (${d.cases.length})</h2><div class="table-wrap"><table><thead><tr><th>סוג קובץ</th><th class="num">סכום</th><th>סטטוס</th><th>מטפל</th><th>מעקב הבא</th><th>פעולות</th></tr></thead><tbody>
      ${d.cases.map((c) => `<tr><td><strong>${esc(c.source_name || '—')}</strong><div class="small muted">${esc(c.charge_items || '')}</div></td><td class="num">${money(c.total_amount)}</td>
        <td>${badge(c.status)}</td>
        <td>${can('assign') && state.users ? `<select class="inline-select" data-pas="${c.id}">${userOptions(c.assigned_user_id)}</select>` : esc(c.assignee || '—')}</td>
        <td class="small nowrap">${c.next_followup_date ? fdate(c.next_followup_date) : '—'}</td>
        <td class="nowrap">${can('change_status') ? `<button class="btn sm" data-pst="${c.id}">שינוי סטטוס</button> <button class="btn sm" data-poc="${c.id}">תיעוד שיחה</button> ` : ''}<a class="btn sm" href="#/case/${c.id}">לתיק המלא</a></td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="card"><h2>פירוט מלא – כל הוראת קבע שחזרה (${d.events.length})</h2><div class="table-wrap"><table><thead><tr><th>תאריך</th><th>סוג קובץ</th><th>סעיף חיוב</th><th class="num">סכום</th><th>סיבה</th><th>מצב</th><th>מטפל</th><th>מעקב הבא</th><th></th></tr></thead><tbody>
      ${d.events.map((e) => { const c = d.cases.find((x) => x.id === e.case_id) || {}; const done = e.status === 'resolved' || ['resolved', 'unresolvable'].includes(c.status);
        return `<tr><td class="small nowrap">${fdate(e.charge_date)}</td><td><strong>${esc(e.source_name || c.source_name || '—')}</strong></td><td>${esc(e.charge_item || '—')}</td><td class="num">${money(e.amount)}</td>
        <td class="small">${esc(e.reason || e.method_status || '')}</td><td>${done ? '<span class="badge st-resolved">טופל</span>' : '<span class="badge st-new">פתוח</span>'}</td>
        <td class="small">${esc(c.assignee || '—')}</td><td class="small nowrap">${c.next_followup_date ? fdate(c.next_followup_date) : '—'}</td><td><a class="btn sm" href="#/case/${e.case_id}">לתיק</a></td></tr>`; }).join('')}
      ${d.events.length ? `<tr><td colspan="3"><strong>סה"כ פתוח</strong></td><td class="num"><strong>${money(d.events.filter((e) => e.status !== 'resolved').reduce((x, e) => x + (e.amount || 0), 0))}</strong></td><td colspan="5"></td></tr>` : ''}
    </tbody></table></div></div>
    <div class="card"><h2>הודעות קוליות שקיבל (${d.voice.length})</h2>${d.voice.length ? `<div class="table-wrap"><table><thead><tr><th>מתי</th><th>סוג</th><th>טלפון</th><th>מצב</th><th>הקשה</th><th>הקלטה</th><th>תמלול</th></tr></thead><tbody>
      ${d.voice.map((v) => `<tr><td class="small nowrap">${fdate(v.created_at)}</td><td class="small">${esc(v.source_name || '')}</td><td><span class="ltr">${esc(v.phone)}</span></td><td><span class="badge ${VOICE_CLS[v.status] || ''}">${esc(VOICE_ST[v.status] || v.status)}</span>${listenBadge(v)}</td>
        <td class="small">${esc(DIG[v.digit_pressed] || '')}</td><td>${v.recording_url || v.local_file ? `<audio controls preload="none" src="/api/voice/${v.id}/recording" style="height:32px;max-width:200px"></audio>` : ''}</td><td class="small" style="max-width:320px">${transcriptCell(v, 'call')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">לא נשלחו הודעות</div>'}</div>
    <div class="card"><h2>כל מה שנעשה – מכל המטפלים</h2>${d.actions.length ? `<ul class="timeline">${d.actions.map((a) => `<li class="${ACTION_TYPES[a.type] ? '' : 'sys'}">
      <div class="meta">${fdate(a.created_at)}<br>${esc(a.user_name || 'מערכת')}<div class="kind">${esc(a.source_name || '')}${a.source_name ? ' · ' : ''}${esc(ACTION_TYPES[a.type] || SYS_TYPES[a.type] || a.type)}</div></div>
      <div class="txt">${esc(a.text)}</div></li>`).join('')}</ul>` : '<div class="empty">עדיין לא נעשה כלום</div>'}</div>`);
  bindShell();
  const reloadP = () => renderPerson(id);
  const caseOf = (cid) => ({ ...ct, ...d.cases.find((x) => x.id === +cid), id: +cid });
  document.querySelectorAll('[data-pst]').forEach((b) => (b.onclick = () => statusDialog(caseOf(b.dataset.pst), reloadP)));
  document.querySelectorAll('[data-poc]').forEach((b) => (b.onclick = () => outcomeDialog(caseOf(b.dataset.poc), reloadP)));
  document.querySelectorAll('[data-pas]').forEach((sel) => (sel.onchange = async () => { try { await api('POST', `/api/cases/${sel.dataset.pas}/assign`, { user_id: sel.value || null }); toast('השיוך עודכן'); reloadP(); } catch (err) { toast(err.message, true); } }));
  const pe = document.getElementById('pEdit');
  if (pe) pe.onclick = () => {
    const f = [['full_name', 'שם מלא'], ['phone1', 'טלפון 1'], ['phone2', 'טלפון 2'], ['phone3', 'טלפון 3'], ['email', 'דוא"ל'], ['address', 'כתובת'], ['city', 'עיר']];
    const m = modal(`<h2>עריכת פרטי איש קשר</h2><div class="grid2">${f.map(([k, l]) => `<div class="field"><label>${l}</label><input type="text" name="${k}" value="${esc(ct[k] || '')}"></div>`).join('')}</div>
      <div class="modal-actions"><button class="btn primary" id="ok">שמירה</button><button class="btn" data-close>ביטול</button></div>`, 'wide');
    m.querySelector('#ok').onclick = async () => { try { await api('PUT', `/api/contacts/${ct.id}`, formData(m)); m.remove(); toast('נשמר'); reloadP(); } catch (err) { toast(err.message, true); } };
  };
  const ps = document.getElementById('pSend');
  if (ps) ps.addEventListener('click', async () => {
    if (!confirm(`לשלוח ל${ct.full_name} הודעה קולית אחת על ${d.preview.count} הוראות?`)) return;
    ps.disabled = true;
    const g = await warmGate({ contact_id: id }); if (!g) { ps.disabled = false; return; }
    try { const r = await api('POST', `/api/people/${id}/voice`, g); toast(r.window ? r.window.label : 'ההודעה נשלחה'); renderPerson(id); } catch (e) { ps.disabled = false; }
  });
}

// ---------- דוח מסודר להדפסה / שמירה כ-PDF ----------
async function renderReport() {
  await loadSources();
  const f = state.rep || (state.rep = { status: 'open', source: '' });
  const d = await api('GET', '/api/report?' + new URLSearchParams(f));
  const groups = new Map();
  for (const c of d.cases) { const k = c.source_name || 'ללא סוג'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  const sum = (list) => list.reduce((a, c) => a + (c.total_amount || 0), 0);
  const byStatus = Object.keys(STATUSES).map((k) => [k, d.cases.filter((c) => c.status === k).length]).filter(([, n]) => n);
  $app.innerHTML = shell('cases', `
    <div class="page-head no-print"><div><h1>דוח מסודר – הדפסה / PDF</h1><p class="sub">בוחרים מה להציג ולוחצים "שמירה כ-PDF". בחלון שנפתח בוחרים ביעד: "שמירה כ-PDF".</p></div>
      <div class="row"><select id="rSt" class="inline-select"><option value="open">רק תיקים פתוחים</option><option value="all" ${f.status === 'all' ? 'selected' : ''}>כל התיקים</option></select>
      <select id="rSrc" class="inline-select"><option value="">כל המוסדות</option>${state.sources.map((x) => `<option value="${x.id}" ${String(x.id) === f.source ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <button class="btn primary" id="rPrint">🖨️ שמירה כ-PDF / הדפסה</button></div></div>
    <div class="report">
      <div class="rep-head"><h1>${esc(d.org || state.orgName)} – דוח החזרות הוראות קבע</h1><p>${d.onlyOpen ? 'תיקים פתוחים' : 'כל התיקים'} · הופק ב-${fdate(d.generated_at)}</p></div>
      <div class="stat-row"><div class="stat"><div class="v">${d.cases.length}</div><div class="l">תיקים</div></div><div class="stat"><div class="v">${money(sum(d.cases))}</div><div class="l">סכום כולל</div></div>
        ${byStatus.map(([k, n]) => `<div class="stat"><div class="v">${n}</div><div class="l">${STATUSES[k]}</div></div>`).join('')}</div>
      ${[...groups.entries()].map(([name, list]) => `<h2 class="rep-group">${esc(name)} · ${list.length} תיקים · ${money(sum(list))}</h2>
        <table class="rep-table"><thead><tr><th>שם</th><th>מזהה</th><th>טלפון</th><th>מה חזר (סעיף · סכום · סיבה)</th><th class="num">סה"כ</th><th>סטטוס</th><th>מטפל</th></tr></thead><tbody>
        ${list.map((c) => `<tr><td><strong>${esc(c.full_name || '')}</strong></td><td>${esc(c.external_id || '')}</td><td><span class="ltr">${esc(c.phone1 || '')}</span></td>
          <td class="small">${c.events.map((e) => `${esc(e.charge_item || 'הוראת קבע')} · ${money(e.amount)}${e.reason ? ' · ' + esc(e.reason) : ''}${e.status === 'resolved' ? ' (הוסדר)' : ''}`).join('<br>')}</td>
          <td class="num">${money(c.total_amount)}</td><td>${esc(STATUSES[c.status] || c.status)}</td><td>${esc(c.assignee || '—')}</td></tr>`).join('')}
        </tbody></table>`).join('') || '<div class="empty">אין תיקים</div>'}
    </div>`);
  bindShell();
  document.getElementById('rSt').onchange = (e) => { f.status = e.target.value; renderReport(); };
  document.getElementById('rSrc').onchange = (e) => { f.source = e.target.value; renderReport(); };
  document.getElementById('rPrint').onclick = () => window.print();
}

// ---------- מסך בקרה ----------
async function renderControl() {
  await Promise.all([loadSources(), loadUsers()]);
  const f = state.ctl || (state.ctl = { source: '', worker: '', from: '', to: '', status: '', q: '', tab: 'multiPeople' });
  const d = await api('GET', '/api/control?' + new URLSearchParams({ source: f.source, worker: f.worker, from: f.from, to: f.to, status: f.status, q: f.q }));
  const m = d.metrics;
  const K = [
    ['returned', 'הוראות קבע שחזרו', `${m.returned} (${money(m.returned_amount)})`, null],
    ['multiPeople', 'אנשים עם יותר מהוראה אחת', m.multi_people, 'multiPeople'],
    ['unpaid', 'אנשים שעדיין לא הסדירו', m.unpaid_people, null],
    ['manual', 'הודעות ידניות', m.manual_msgs, 'manual'],
    ['auto', 'הודעות אוטומטיות', m.auto_msgs, 'auto'],
    ['due', 'אמורים לקבל תזכורת', m.due_reminders, 'due'],
    ['noMethod', 'ללא אמצעי תשלום', m.no_method, 'noMethod'],
    ['expiring', 'אמצעי תשלום עומד לפוג (60 יום)', m.expiring, 'expiring'],
    ['recordings', 'הקלטות שהתקבלו', m.recordings, 'recordings'],
    ['transcribed', 'תומללו בהצלחה', `${m.transcribed}${m.transcribe_failed ? ` · ${m.transcribe_failed} נכשלו` : ''}`, 'recordings'],
    ['pending', 'ממתינות לטיפול העובדים', m.pending_handling, 'recordings'],
  ];
  const L = d.lists;
  const row = (cells) => `<tr>${cells.map((c) => `<td class="small">${c}</td>`).join('')}</tr>`;
  const tbl = (head, rows) => rows.length ? `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<div class="empty">אין נתונים</div>';
  const P = (name, id) => (id ? `<a href="#/person/${id}">${esc(name || '')}</a>` : esc(name || ''));
  const views = {
    multiPeople: () => tbl(['אדם', 'טלפון', 'הוראות פתוחות', 'סכום'], L.multiPeople.map((r) => row([P(r.full_name, r.id), `<span class="ltr">${esc(r.phone1 || '')}</span>`, r.n, money(r.amt)]))),
    manual: () => tbl(['מתי', 'אדם', 'מצב', 'נשלח ע"י'], L.manual.map((r) => row([fdate(r.created_at), `<a href="#/case/${r.case_id}">${esc(r.full_name)}</a>`, esc(VOICE_ST[r.status] || r.status), esc(r.sent_by || '')]))),
    auto: () => tbl(['מתי', 'אדם', 'סוג', 'מצב'], L.auto.map((r) => row([fdate(r.created_at), `<a href="#/case/${r.case_id}">${esc(r.full_name)}</a>`, esc(TRIGGER[r.trigger] || r.trigger) + (r.reminder_no ? ' ' + r.reminder_no : ''), esc(VOICE_ST[r.status] || r.status)]))),
    due: () => tbl(['אדם', 'טלפון', 'תזכורת מס\'', 'מחושב מ-'], L.due.map((r) => row([`<a href="#/case/${r.case_id}">${esc(r.full_name)}</a>`, `<span class="ltr">${esc(r.phone1 || '')}</span>`, r.reminder_no, fdate(r.base)]))),
    noMethod: () => tbl(['אדם', 'מזהה', 'טלפון'], L.noMethod.map((r) => row([`<a href="#/case/${r.case_id}">${esc(r.full_name)}</a>`, esc(r.external_id), `<span class="ltr">${esc(r.phone1 || '')}</span>`]))),
    expiring: () => tbl(['אדם', 'תוקף', 'תאריך פקיעה', 'ימים שנותרו'], L.expiring.map((r) => row([`<a href="#/case/${r.case_id}">${esc(r.full_name)}</a>`, esc(r.expiry), fdate(r.expiry_date), r.days_left < 0 ? '<span class="overdue">פג</span>' : r.days_left]))),
    recordings: () => tbl(['מתי', 'אדם', 'תמלול', 'מצב'], [...L.recordings.map((r) => row([fdate(r.created_at), `<a href="#/case/${r.case_id}">${esc(r.full_name)}</a>`, esc(r.transcript || TR_STATUS[r.transcript_status] || ''), r.handled ? 'טופל' : '<span class="overdue">ממתין</span>'])),
      ...L.unknown.map((r) => row([fdate(r.created_at), `<span class="ltr">${esc(r.phone)}</span> (ללא תיק)`, esc(r.transcript || TR_STATUS[r.transcript_status] || ''), r.handled ? 'טופל' : '<span class="overdue">ממתין</span>']))]),
  };
  $app.innerHTML = shell('control', `
    <div class="page-head"><div><h1>מסך בקרה</h1><p class="sub">כל המנגנונים במקום אחד · שליחה: ${d.automation.send_mode === 'unified' ? 'הודעה מאוחדת לאדם' : 'הודעה לכל תיק'} · הודעה חודשית: ${d.automation.monthly_enabled ? 'מופעלת' : 'כבויה'} · התראות תוקף: ${d.automation.expiry_enabled ? 'מופעלות' : 'כבויות'}</p></div>
      ${isAdmin() ? '<div class="row"><button class="btn" data-run="reminders">הרצת תזכורות עכשיו</button><button class="btn" data-run="monthly">הודעה חודשית עכשיו</button><button class="btn" data-run="expiry">התראות תוקף עכשיו</button></div>' : ''}</div>
    <div class="toolbar">
      <input type="search" id="cq" class="search" placeholder="חיפוש: שם, מזהה או טלפון" value="${esc(f.q)}">
      <select id="cs" class="inline-select"><option value="">כל המוסדות</option>${state.sources.map((x) => `<option value="${x.id}" ${String(x.id) === f.source ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <select id="cw" class="inline-select"><option value="">כל העובדים</option>${state.users.filter((u) => u.active).map((u) => `<option value="${u.id}" ${String(u.id) === f.worker ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select>
      <select id="cst" class="inline-select"><option value="">כל הסטטוסים</option>${Object.entries(STATUSES).map(([k, l]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="small" style="margin:0">מתאריך</label><input type="date" id="cf" value="${esc(f.from)}" style="width:auto"><label class="small" style="margin:0">עד</label><input type="date" id="ct" value="${esc(f.to)}" style="width:auto">
    </div>
    <div class="kpis" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr))">${K.map(([k, l, val, tab]) => `<div class="kpi" ${tab ? `data-tab="${tab}"` : ''} style="${tab === f.tab ? 'border-color:var(--primary)' : ''}"><div class="label">${l}</div><div class="value" style="font-size:24px">${val}</div></div>`).join('')}</div>
    <div class="card"><h2>${(K.find((x) => x[3] === f.tab) || [])[1] || ''}</h2>${(views[f.tab] || views.multiPeople)()}</div>`);
  bindShell();
  const upd = (k) => (e) => { f[k] = e.target.value; renderControl(); };
  document.getElementById('cs').onchange = upd('source'); document.getElementById('cw').onchange = upd('worker'); document.getElementById('cst').onchange = upd('status');
  document.getElementById('cf').onchange = upd('from'); document.getElementById('ct').onchange = upd('to');
  let t; document.getElementById('cq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; renderControl(); }, 400); };
  document.querySelectorAll('[data-tab]').forEach((el) => el.addEventListener('click', () => { f.tab = el.dataset.tab; renderControl(); }));
  document.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { const r = await api('POST', '/api/automations/run', { kind: b.dataset.run }); const x = r.result || {}; toast(x.skipped === 'disabled' ? 'המנגנון כבוי בהגדרות' : `נכנסו לשליחה: ${x.queued || 0}${x.due != null ? ` (מתוך ${x.due} שזכאים)` : ''} · ${r.window.label}`); renderControl(); }
    catch (e) { b.disabled = false; toast(e.message, true); }
  }));
}
