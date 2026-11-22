// לוח שנה עברי: זיהוי שבת וחג (לפי זמני הדלקת נרות והבדלה בירושלים), חול המועד ותשעה באב – כדי שלא תצא אף שיחה בזמנים האלה
const { HebrewCalendar, Location, HDate, flags } = require('@hebcal/core');
const { getSetting } = require('./db');
const LOC = Location.lookup('Jerusalem');
const stripNiqqud = (s) => String(s).replace(/[֑-ׇ]/g, '');
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function hebDate(d = new Date(), withYear = true) {
  const s = stripNiqqud(new HDate(d).renderGematriya());
  return withYear ? s : s.split(' ').slice(0, -1).join(' ');
}
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const dayLabel = (d) => `יום ${DAYS[d.getDay()]} ${hm(d)}`;

function events(from, to) {
  return HebrewCalendar.calendar({ start: from, end: to, candlelighting: true, location: LOC, il: true });
}
// כל תקופות העצירה בטווח: [התחלה, סוף, סיבה]
function blockedSpans(from, to) {
  const stopMin = +(getSetting('shabbat_stop_minutes') || 120);
  const resume = getSetting('shabbat_resume') || 'next_morning'; // next_morning = לא במוצאי שבת/חג; after_havdalah = שעה אחרי הבדלה
  const evs = events(new Date(from.getTime() - 3 * 864e5), new Date(to.getTime() + 3 * 864e5));
  const candles = evs.filter((e) => /Candle lighting/.test(e.getDesc()) && e.eventTime).map((e) => e.eventTime).sort((a, b) => a - b);
  const havdalot = evs.filter((e) => /Havdalah/.test(e.getDesc()) && e.eventTime).map((e) => e.eventTime).sort((a, b) => a - b);
  const spans = [];
  for (const c of candles) {
    const h = havdalot.find((x) => x > c); if (!h) continue;
    const start = new Date(c.getTime() - stopMin * 60e3);
    const end = resume === 'after_havdalah' ? new Date(h.getTime() + 60 * 60e3) : new Date(h.getFullYear(), h.getMonth(), h.getDate() + 1, 0, 0);
    const isChag = evs.some((e) => (e.getFlags() & flags.CHAG) && e.getDate().greg() >= new Date(c.getFullYear(), c.getMonth(), c.getDate()) && e.getDate().greg() <= h);
    const reason = isChag ? (c.getDay() === 5 || h.getDay() === 6 ? 'שבת וחג' : 'חג') : 'שבת';
    const last = spans[spans.length - 1];
    if (last && start <= last[1]) { last[1] = end > last[1] ? end : last[1]; if (last[2] !== reason) last[2] = 'שבת וחג'; } else spans.push([start, end, reason]);
  }
  // ימים שלמים: חול המועד, תשעה באב
  for (const e of evs) {
    const f = e.getFlags(); const g = e.getDate().greg();
    const dayStart = new Date(g.getFullYear(), g.getMonth(), g.getDate()); const dayEnd = new Date(dayStart.getTime() + 864e5);
    if ((f & flags.CHOL_HAMOED) && getSetting('block_chol_hamoed') !== '0') spans.push([dayStart, dayEnd, 'חול המועד']);
    if (/Tish'a B'Av/.test(e.getDesc()) && getSetting('block_tisha_bav') !== '0') spans.push([dayStart, dayEnd, 'תשעה באב']);
  }
  return spans.sort((a, b) => a[0] - b[0]);
}
// האם עכשיו אסור לשלוח, ועד מתי
function status(now = new Date()) {
  const spans = blockedSpans(now, new Date(now.getTime() + 12 * 864e5));
  let hit = spans.find(([s, e]) => now >= s && now < e);
  if (!hit) return { blocked: false };
  let until = hit[1];
  for (const sp of spans) if (sp[0] <= until && sp[1] > until) until = sp[1]; // תקופות רצופות (שבת שאחריה חג וכו')
  return { blocked: true, reason: hit[2], until, untilLabel: dayLabel(until) };
}
// התקופה הקרובה (להצגה בהגדרות)
function nextBlock(now = new Date()) {
  const sp = blockedSpans(now, new Date(now.getTime() + 21 * 864e5)).find(([, e]) => e > now);
  return sp ? { reason: sp[2], from: dayLabel(sp[0]), to: dayLabel(sp[1]), fromHeb: hebDate(sp[0], false) } : null;
}
module.exports = { hebDate, status, nextBlock };
