// Per-student learning data: topic stats (strength/weakness + time), bookmarks & notes, XP/streak/badges,
// study planner and local attempt history.
// LOCAL-FIRST: everything works signed-out (localStorage); signed-in students also get it synced to Firestore
// (users/{uid}/stats|bookmarks|profile -- see firestore.rules) so it follows them across devices.
// Cloud writes are always best-effort: a failure never blocks practice.

import { doc, getDoc, setDoc, getDocs, collection, deleteDoc, increment, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db, getCurrentUser, authReady } from "./auth.js?v=5";

const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export function hash36(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
async function uid() { await authReady; return getCurrentUser()?.uid || null; }

// ---------------------------------------------------------------- topic stats (F17, F34, F03)
/** Adds one finished test into the per-topic counters (correct / wrong / skipped / seconds). */
export async function recordStats(examSlug, questions, answers, times) {
  const delta = {};
  for (const q of questions) {
    const given = answers[q.id];
    const key = `${q.subject || "Other"}||${q.topic || ""}`;
    const d = (delta[hash36(key)] ??= { n: key, c: 0, w: 0, s: 0, k: 0 });
    d.s += Math.round(times[q.id] || 0);
    if (given == null) d.k++; else if (given === q.correct_option) d.c++; else d.w++;
  }
  const local = lsGet(`stats:${examSlug}`, {});
  for (const [h, d] of Object.entries(delta)) {
    const l = (local[h] ??= { n: d.n, c: 0, w: 0, s: 0, k: 0 });
    l.c += d.c; l.w += d.w; l.s += d.s; l.k += d.k;
  }
  lsSet(`stats:${examSlug}`, local);
  const u = await uid();
  if (!u) return;
  const payload = {};
  for (const [h, d] of Object.entries(delta)) {
    payload[`n_${h}`] = d.n; payload[`c_${h}`] = increment(d.c); payload[`w_${h}`] = increment(d.w);
    payload[`s_${h}`] = increment(d.s); payload[`k_${h}`] = increment(d.k);
  }
  try { await setDoc(doc(db, "users", u, "stats", examSlug), payload, { merge: true }); }
  catch (e) { console.warn("Could not sync stats (best-effort):", e); }
}

/** [{subject, topic, c, w, s, k}] for one exam (cloud copy when signed in, else this browser's). */
export async function loadStats(examSlug) {
  let map = lsGet(`stats:${examSlug}`, {});
  const u = await uid();
  if (u) {
    try {
      const snap = await getDoc(doc(db, "users", u, "stats", examSlug));
      if (snap.exists()) {
        const d = snap.data();
        map = {};
        for (const k of Object.keys(d)) if (k.startsWith("n_")) {
          const h = k.slice(2);
          map[h] = { n: d[k], c: d[`c_${h}`] || 0, w: d[`w_${h}`] || 0, s: d[`s_${h}`] || 0, k: d[`k_${h}`] || 0 };
        }
      }
    } catch (e) { /* fall back to local */ }
  }
  return Object.values(map).map((x) => { const [subject, topic] = x.n.split("||"); return { subject, topic, c: x.c, w: x.w, s: x.s, k: x.k }; });
}

/** Weakest topics: at least `minAnswered` answered, sorted by accuracy ascending. */
export function weakTopics(stats, minAnswered = 4, limit = 5) {
  return stats.filter((x) => x.topic && x.c + x.w >= minAnswered)
    .map((x) => ({ ...x, acc: x.c / (x.c + x.w) }))
    .sort((a, b) => a.acc - b.acc).slice(0, limit);
}

// ---------------------------------------------------------------- local attempt history (F24, F16 display)
export function addHistory(examSlug, rec) {
  const h = lsGet(`hist:${examSlug}`, []);
  h.push({ ts: Date.now(), ...rec });
  lsSet(`hist:${examSlug}`, h.slice(-300));
}
export const getHistory = (examSlug) => lsGet(`hist:${examSlug}`, []);

/** Best score % and attempt count for one fixed mock/paper of one exam. */
export function mockSummary(examSlug, mockId) {
  const rows = getHistory(examSlug).filter((r) => r.mockId === mockId);
  if (!rows.length) return null;
  return { attempts: rows.length, bestPct: Math.max(...rows.map((r) => r.pct)), last: rows[rows.length - 1] };
}

// ---------------------------------------------------------------- bookmarks + notes (F20, F44)
const bmDocId = (slug, qid) => `${slug}__${hash36(qid)}`;

/** Compact copy of a question (no figure image) so a bookmark stays readable without loading a pool. */
export function questionSnapshot(q) {
  const cut = (l) => l && { question: l.question, options: l.options, explanation: l.explanation || "" };
  return { id: q.id, qkey: q.qkey || "", subject: q.subject || "", topic: q.topic || "", correct_option: q.correct_option,
           hindi: cut(q.hindi), english: cut(q.english), hasImage: !!q.image };
}

export function getBookmarksLocal() { return lsGet("bookmarks:v1", {}); }
export function isBookmarked(slug, qid) { return !!getBookmarksLocal()[`${slug}::${qid}`]; }

export async function toggleBookmark(slug, q) {
  const all = getBookmarksLocal();
  const key = `${slug}::${q.id}`;
  if (all[key]) {
    delete all[key]; lsSet("bookmarks:v1", all);            // local first: never wait on the network for the UI state
    const u = await uid();
    if (u) { try { await deleteDoc(doc(db, "users", u, "bookmarks", bmDocId(slug, q.id))); } catch (e) {} }
    return false;
  }
  all[key] = { slug, qid: q.id, snap: questionSnapshot(q), note: "", ts: Date.now() };
  lsSet("bookmarks:v1", all);
  const u = await uid();
  if (u) { try { await setDoc(doc(db, "users", u, "bookmarks", bmDocId(slug, q.id)), { ...all[key], ts: serverTimestamp() }); } catch (e) {} }
  return true;
}

export async function setNote(slug, q, note) {
  const all = getBookmarksLocal();
  const key = `${slug}::${q.id}`;
  all[key] = all[key] || { slug, qid: q.id, snap: questionSnapshot(q), note: "", ts: Date.now() };
  all[key].note = String(note || "").slice(0, 1000);
  lsSet("bookmarks:v1", all);
  const u = await uid();
  if (u) { try { await setDoc(doc(db, "users", u, "bookmarks", bmDocId(slug, q.id)), { ...all[key], ts: serverTimestamp() }); } catch (e) {} }
}

/** All bookmarks: local ones merged with the signed-in student's cloud copy (union; local-only ones are pushed up). */
export async function loadBookmarks() {
  const all = getBookmarksLocal();
  const u = await uid();
  if (u) {
    try {
      const snap = await getDocs(collection(db, "users", u, "bookmarks"));
      const cloudKeys = new Set();
      snap.forEach((d) => {
        const v = d.data(); const key = `${v.slug}::${v.qid}`;
        cloudKeys.add(key);
        if (!all[key]) all[key] = { slug: v.slug, qid: v.qid, snap: v.snap, note: v.note || "", ts: Date.now() };
        else if (v.note && !all[key].note) all[key].note = v.note;
      });
      lsSet("bookmarks:v1", all);
      for (const [key, v] of Object.entries(all)) if (!cloudKeys.has(key)) {
        try { await setDoc(doc(db, "users", u, "bookmarks", bmDocId(v.slug, v.qid)), { ...v, ts: serverTimestamp() }); } catch (e) {}
      }
    } catch (e) { /* local only */ }
  }
  return Object.values(all).sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

// ---------------------------------------------------------------- XP, streak, badges (F25)
export const BADGES = [
  { id: "first_test", icon: "🎯", name: "पहला कदम", desc: "पहला टेस्ट पूरा किया", ok: (g) => g.tests >= 1 },
  { id: "ten_tests", icon: "🔟", name: "10 टेस्ट", desc: "10 टेस्ट पूरे किए", ok: (g) => g.tests >= 10 },
  { id: "first_mock", icon: "📝", name: "मॉक योद्धा", desc: "पहला मॉक/पेपर पूरा किया", ok: (g) => g.mocks >= 1 },
  { id: "five_mocks", icon: "🏅", name: "मॉक मास्टर", desc: "5 मॉक/पेपर पूरे किए", ok: (g) => g.mocks >= 5 },
  { id: "q100", icon: "💯", name: "100 प्रश्न", desc: "100 प्रश्न हल किए", ok: (g) => g.answered >= 100 },
  { id: "q500", icon: "🚀", name: "500 प्रश्न", desc: "500 प्रश्न हल किए", ok: (g) => g.answered >= 500 },
  { id: "q2000", icon: "🌟", name: "2000 प्रश्न", desc: "2000 प्रश्न हल किए", ok: (g) => g.answered >= 2000 },
  { id: "streak3", icon: "🔥", name: "3 दिन की स्ट्रीक", desc: "लगातार 3 दिन अभ्यास", ok: (g) => g.best >= 3 },
  { id: "streak7", icon: "⚡", name: "7 दिन की स्ट्रीक", desc: "लगातार 7 दिन अभ्यास", ok: (g) => g.best >= 7 },
  { id: "streak30", icon: "👑", name: "30 दिन की स्ट्रीक", desc: "लगातार 30 दिन अभ्यास", ok: (g) => g.best >= 30 },
  { id: "acc80", icon: "🎓", name: "सटीक निशाना", desc: "20+ प्रश्नों के टेस्ट में 80%+ accuracy", ok: (g) => g.flags.acc80 },
  { id: "perfect", icon: "💎", name: "परफेक्ट स्कोर", desc: "10+ प्रश्नों के टेस्ट में सभी सही", ok: (g) => g.flags.perfect },
  { id: "speed", icon: "⏱", name: "तेज़ रफ़्तार", desc: "औसत 30 सेकंड/प्रश्न से कम और 70%+ accuracy (20+ प्रश्न)", ok: (g) => g.flags.speed },
  { id: "topic_master", icon: "🧠", name: "टॉपिक मास्टर", desc: "किसी टॉपिक में 20+ प्रश्नों पर 85%+ accuracy", ok: (g) => g.flags.topic },
];

const emptyGam = () => ({ xp: 0, tests: 0, mocks: 0, answered: 0, correct: 0, streak: 0, best: 0, last: "", badges: {}, flags: {} });
export const getGam = () => ({ ...emptyGam(), ...lsGet("gam:v1", {}) });
export const levelOf = (xp) => Math.floor(Math.sqrt(xp / 60)) + 1;

async function saveGam(g) {
  lsSet("gam:v1", g);
  const u = await uid();
  if (u) { try { await setDoc(doc(db, "users", u, "profile", "gamification"), { ...g, updatedAt: serverTimestamp() }, { merge: true }); } catch (e) {} }
}

/** Pull the cloud copy once per page view and keep the larger counters/streak and the union of badges. */
export async function syncGam() {
  const u = await uid();
  if (!u) return getGam();
  const g = getGam();
  try {
    const snap = await getDoc(doc(db, "users", u, "profile", "gamification"));
    if (snap.exists()) {
      const c = snap.data();
      for (const k of ["xp", "tests", "mocks", "answered", "correct", "best"]) g[k] = Math.max(g[k], c[k] || 0);
      if ((c.last || "") > g.last) { g.last = c.last; g.streak = c.streak || 0; }
      g.badges = { ...(c.badges || {}), ...g.badges };
      g.flags = { ...(c.flags || {}), ...g.flags };
      lsSet("gam:v1", g);
    }
  } catch (e) {}
  return g;
}

/** Marks today as a practice day (any test or the Question of the Day); returns the current streak. */
export function touchDay() {
  const g = getGam();
  const t = today();
  if (g.last === t) return g.streak;
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yd = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  g.streak = g.last === yd ? g.streak + 1 : 1;
  g.best = Math.max(g.best, g.streak);
  g.last = t;
  saveGam(g);
  return g.streak;
}

/** Called once per finished test. Returns {xpGained, newBadges:[...], gam}. */
export async function awardAfterTest({ examSlug, answered, correct, wrong, total, timeSec, isFixed, topicStats }) {
  touchDay();            // updates + saves the streak fields first ...
  const g = getGam();    // ... so this read already includes them
  const xpGained = answered + correct * 2 + 20 + (isFixed ? 50 : 0);
  g.xp += xpGained; g.tests += 1; g.answered += answered; g.correct += correct; if (isFixed) g.mocks += 1;
  const acc = correct + wrong ? correct / (correct + wrong) : 0;
  if (total >= 20 && acc >= 0.8) g.flags.acc80 = true;
  if (total >= 10 && correct === total) g.flags.perfect = true;
  if (total >= 20 && answered && timeSec / answered < 30 && acc >= 0.7) g.flags.speed = true;
  if ((topicStats || []).some((x) => x.topic && x.c + x.w >= 20 && x.c / (x.c + x.w) >= 0.85)) g.flags.topic = true;
  const newBadges = BADGES.filter((b) => !g.badges[b.id] && b.ok(g));
  newBadges.forEach((b) => { g.badges[b.id] = Date.now(); });
  // today's question count for the planner
  const dk = `daily:${examSlug}:${today()}`;
  lsSet(dk, (lsGet(dk, 0) || 0) + answered);
  await saveGam(g);
  return { xpGained, newBadges, gam: g };
}

// ---------------------------------------------------------------- study planner (F49)
export const getPlan = (slug) => lsGet(`plan:${slug}`, null);
export async function setPlan(slug, plan) {
  lsSet(`plan:${slug}`, plan);
  const u = await uid();
  if (u) { try { await setDoc(doc(db, "users", u, "profile", "plans"), { [slug]: plan }, { merge: true }); } catch (e) {} }
}
export async function syncPlans() {
  const u = await uid();
  if (!u) return;
  try {
    const snap = await getDoc(doc(db, "users", u, "profile", "plans"));
    if (snap.exists()) for (const [slug, plan] of Object.entries(snap.data())) if (!getPlan(slug)) lsSet(`plan:${slug}`, plan);
  } catch (e) {}
}
export const todayCount = (slug) => lsGet(`daily:${slug}:${today()}`, 0) || 0;
export function daysLeft(dateStr) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(dateStr + "T00:00:00") - t) / 86400000);
}
