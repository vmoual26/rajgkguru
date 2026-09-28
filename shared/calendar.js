// Exam-calendar helpers shared by the home page and the RPSC / RMSSB pages.
// Data: /exam_calendar.json (built weekly by scripts/build_exam_calendar.py). Events in the past are
// filtered out here, at view time, so a stale file can never show a finished exam.

const MONTHS = ["जन", "फ़र", "मार्च", "अप्रै", "मई", "जून", "जुला", "अग", "सित", "अक्टू", "नव", "दिस"];

export async function loadCalendar() {
  try {
    const r = await fetch("/exam_calendar.json", { cache: "no-cache" });
    if (!r.ok) return [];
    const { events } = await r.json();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return (events || []).filter((e) => new Date(e.date + "T00:00:00") >= today);
  } catch (e) {
    return [];
  }
}

export function daysUntil(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((new Date(dateStr + "T00:00:00") - today) / 86400000);
}

export function formatDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Nearest upcoming event per exam slug: { slug: event }. */
export function nearestBySlug(events) {
  const out = {};
  for (const e of events) if (!out[e.slug] || e.date < out[e.slug].date) out[e.slug] = e;
  return out;
}

/** Exams with an upcoming date first (soonest first); undated exams keep their original order after. */
export function sortByNearestDate(exams, events) {
  const near = nearestBySlug(events);
  const idx = new Map(exams.map((e, i) => [e.slug, i]));
  return [...exams].sort((a, b) => {
    const da = near[a.slug]?.date, db = near[b.slug]?.date;
    if (da && db) return da.localeCompare(db) || idx.get(a.slug) - idx.get(b.slug);
    if (da) return -1;
    if (db) return 1;
    return idx.get(a.slug) - idx.get(b.slug);
  });
}

/** Small chip for an exam card: "📅 6 दिस 2026 · 69 दिन शेष", or "" if no upcoming date. */
export function dateChipHtml(event) {
  if (!event) return "";
  const n = daysUntil(event.date);
  return `<div class="exam-date-chip">📅 ${formatDate(event.date)} · ${n === 0 ? "आज" : `${n} दिन शेष`}</div>`;
}

/** The next `max` events (one per exam, soonest first) for the home-page carousel. */
export function upcomingForCarousel(events, max = 5) {
  return Object.values(nearestBySlug(events)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, max);
}
