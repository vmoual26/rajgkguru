// Shared logic for index.html (renderHome), custom.html (renderCustomBuilder), and
// test.html (renderTest). No backend, no build step -- reads the static pool JSON
// files under data/ and does everything else (test assembly, scoring, seen-question
// tracking) in the browser.
//
// A "test" is assembled ON DEMAND by sampling from a pool, not loaded from a
// pre-built file -- see sampleTest(). Which questions a viewer has already been
// shown is tracked in localStorage (per pool) so repeat draws favour unseen
// questions until a pool is exhausted -- see getSeen()/addSeen() (one global set per student).
//
// Paid-tier access and saved progress (separate from the localStorage
// no-repeat tracking above, which is per-browser) come from
// shared/entitlements.js -- account-based, works across devices.
import { checkEntitlement, buyAccess, recordAttempt, getWrongQuestionIds, fetchPaidPool, loadCloudSeenKeys, saveCloudSeenKeys, reportMistake } from "../shared/entitlements.js?v=4";
import { renderResultsExtras, enhanceReview, mountHomeExtras, checkReminderTick } from "../shared/insights.js?v=4";
import { toggleBookmark, isBookmarked } from "../shared/userdata.js?v=2";
import { loadCalendar } from "../shared/calendar.js?v=1";
import { openDurationPicker } from "../shared/pricing.js?v=1";

// Paid content is fetched from several places (Full Test, custom test, fixed mocks/PYP); a
// device-limit refusal (fetchPaidPool, see shared/entitlements.js) can surface as an
// unhandled rejection from any of them -- one catch-all here instead of wrapping every call.
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason?.code === "device_limit") { alert(e.reason.message); e.preventDefault(); }
});

const EXAM_SLUG = "sr-teacher-gr-2";
const EXAM_TITLE = "Sr. Teacher Gr. II (Secondary Education)";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

/** Like fetchJson, but resolves to null instead of throwing -- used for
 * subjects_meta.json, which may not exist yet for an exam whose data
 * predates that file (retag_subjects.py's write_subjects_meta). Callers
 * fall back to an ungrouped, English-only subject list when this is null. */
async function fetchJsonOptional(path) {
  try {
    const res = await fetch(path);
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

const OTHER_SECTION = "अन्य विषय (Other)";

/** Groups a pool's actual subjects (whatever's really present in its
 * subject_ratios) into the exam's syllabus-derived sections, with each
 * subject's Hindi name attached -- from subjects_meta.json (see
 * retag_subjects.py's derive_taxonomy/label_existing_subjects). Any subject
 * present in the pool but missing from meta (meta not generated yet, or a
 * genuinely new/unlisted subject) falls back into a catch-all "Other"
 * section with its English name only, rather than being dropped. Returns
 * [{ section, subjects: [{ name, nameHindi, count }] }, ...] in the order
 * sections should be displayed. */
function groupSubjectsBySections(subjectNames, meta, countBySubject) {
  const metaByName = {};
  (meta?.subjects || []).forEach((s) => { metaByName[s.name] = s; });
  const sectionOrder = (meta?.sections || []).map((s) => s.name);

  const bySection = {};
  for (const name of subjectNames) {
    const m = metaByName[name];
    const section = m?.section || OTHER_SECTION;
    (bySection[section] ??= []).push({ name, nameHindi: m?.name_hindi || name, count: countBySubject[name] || 0 });
  }
  const orderedSections = [
    ...sectionOrder.filter((s) => bySection[s]),
    ...Object.keys(bySection).filter((s) => !sectionOrder.includes(s)),
  ];
  return orderedSections.map((section) => ({ section, subjects: bySection[section] }));
}

function subjectLabel(s) {
  return s.nameHindi === s.name ? escapeHtml(s.name) : `${escapeHtml(s.nameHindi)} <span class="en">(${escapeHtml(s.name)})</span>`;
}

/** Rough keyword match on the English subject name -- purely decorative, a
 * reasonable icon beats none, and a wrong guess costs nothing functional.
 * Falls back to a generic book for any subject none of these match. */
function subjectEmoji(name) {
  const n = name.toLowerCase();
  if (/current affairs/.test(n)) return "📰";
  if (/reasoning|mental ability|aptitude|numera/.test(n)) return "🧠";
  if (/computer/.test(n)) return "💻";
  if (/science|technology/.test(n)) return "🔬";
  if (/hindi/.test(n)) return "📝";
  if (/english/.test(n)) return "🔤";
  if (/constitution|polity|political|governance|administrat/.test(n)) return "⚖️";
  if (/econom/.test(n)) return "💰";
  if (/history/.test(n)) return "📜";
  if (/geography/.test(n)) return "🌍";
  if (/culture|heritage|art|literature|tradition/.test(n)) return "🏛️";
  return "📚";
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================================
// Seen-question tracking -- ONE global set per student, across every exam
// ============================================================================
// A student preparing several exams must never meet the same question twice, even when
// it shows up in a different exam's pool (questions are shared between exams). So seen
// state is keyed by each question's content key (`qkey`, identical for the same real
// question in every exam) and stored once, not per exam/pool. Signed-in students'
// set is also synced to Firestore (see entitlements.js) so it follows them across
// devices; the old per-pool lists of exam-local ids are still honoured so nobody's
// existing progress is lost.

const GLOBAL_SEEN_KEY = "seen:global";
const LEGACY_SEEN_KEYS = ["seen:free", "seen:paid"];

function readKeySet(key) {
  try {
    const raw = localStorage.getItem(key);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (e) { return new Set(); }
}

function getSeen() {
  const s = readKeySet(GLOBAL_SEEN_KEY);
  LEGACY_SEEN_KEYS.forEach((k) => readKeySet(k).forEach((id) => s.add(id)));
  return s;
}

function isSeen(seen, q) {
  return seen.has(q.qkey) || seen.has(q.id);
}

function questionSeenKey(q) { return q.qkey || q.id; }

function addSeen(questions) {
  const s = readKeySet(GLOBAL_SEEN_KEY);
  questions.forEach((q) => s.add(questionSeenKey(q)));
  try { localStorage.setItem(GLOBAL_SEEN_KEY, JSON.stringify(Array.from(s))); } catch (e) {}
}

/** Pulls the signed-in student's synced seen-set into this browser before a test is
 * drawn, so questions they practised on another device/exam aren't repeated. Best-effort
 * and time-boxed: practice must never wait on, or break because of, the network. */
async function mergeCloudSeen() {
  try {
    const remote = await Promise.race([
      loadCloudSeenKeys(),
      new Promise((resolve) => setTimeout(() => resolve([]), 2500)),
    ]);
    if (!remote.length) return;
    const s = readKeySet(GLOBAL_SEEN_KEY);
    remote.forEach((k) => s.add(k));
    localStorage.setItem(GLOBAL_SEEN_KEY, JSON.stringify(Array.from(s)));
  } catch (e) {}
}

function resetAllProgress() {
  try {
    localStorage.removeItem(GLOBAL_SEEN_KEY);
    LEGACY_SEEN_KEYS.forEach((k) => localStorage.removeItem(k));
  } catch (e) {}
}

// ============================================================================
// Test assembly -- stratified random sampling from a pool
// ============================================================================

function distributeProportional(weights, total) {
  // weights: {subject: weight} -> {subject: integer count} summing to `total`
  // (largest-remainder method, so rounding always lands on the exact total).
  const entries = Object.entries(weights);
  const sumW = entries.reduce((s, [, w]) => s + w, 0) || 1;
  const raw = entries.map(([s, w]) => [s, (w / sumW) * total]);
  const floors = raw.map(([s, r]) => [s, Math.floor(r)]);
  const used = floors.reduce((s, [, f]) => s + f, 0);
  const remainder = total - used;
  const fracSorted = raw.map(([s, r], i) => [s, r - floors[i][1]]).sort((a, b) => b[1] - a[1]);
  const result = Object.fromEntries(floors);
  for (let i = 0; i < remainder && i < fracSorted.length; i++) result[fracSorted[i][0]] += 1;
  return result;
}

function groupBySubject(questions) {
  const map = {};
  for (const q of questions) (map[q.subject] ??= []).push(q);
  return map;
}

function sampleTest(poolName, pool, { subjects = null, count }) {
  const allSubjects = subjects && subjects.length ? subjects : Object.keys(pool.subject_ratios);
  const weights = {};
  allSubjects.forEach((s) => { weights[s] = pool.subject_ratios[s] || 0.0001; });
  const targets = distributeProportional(weights, count);

  const bySubject = groupBySubject(pool.questions);
  const seen = getSeen();
  const usedTextThisDraw = new Set();

  function pickFrom(list, n) {
    const picked = [];
    for (const q of shuffle(list)) {
      if (picked.length >= n) break;
      const textKey = ((q.hindi && q.hindi.question) || "").trim();
      if (textKey && usedTextThisDraw.has(textKey)) continue; // avoid same worded Q twice in one test
      picked.push(q);
      if (textKey) usedTextThisDraw.add(textKey);
    }
    return picked;
  }

  // Never repeat a question to this student while an unseen one exists (CONTENT_STRATEGY.md
  // 8.5). Order: (1) unseen in each subject up to its share of the real exam mix; (2) if a
  // subject runs short, unseen questions from the other allowed subjects; (3) ONLY when
  // no unseen question is left anywhere, seen ones -- i.e. the pool is exhausted.
  const result = [];
  for (const subject of allSubjects) {
    const unseen = (bySubject[subject] || []).filter((q) => !isSeen(seen, q));
    result.push(...pickFrom(unseen, targets[subject] || 0));
  }

  if (result.length < count) {
    const usedIds = new Set(result.map((q) => q.id));
    const leftoverUnseen = pool.questions.filter((q) => !usedIds.has(q.id) && allSubjects.includes(q.subject) && !isSeen(seen, q));
    result.push(...pickFrom(leftoverUnseen, count - result.length));
  }

  if (result.length < count) {
    const usedIds = new Set(result.map((q) => q.id));
    const leftoverSeen = pool.questions.filter((q) => !usedIds.has(q.id) && allSubjects.includes(q.subject));
    result.push(...pickFrom(leftoverSeen, count - result.length));
  }

  return shuffle(result).slice(0, count);
}

async function startTest({ poolName, count, subjects = null, timeMinutes = null, instant = false, titlePrefix }) {
  const pool = poolName === "paid" ? await fetchPaidPool(EXAM_SLUG) : await fetchJson(`data/pool_${poolName}.json`);
  await mergeCloudSeen();
  const questions = sampleTest(poolName, pool, { subjects, count: Math.min(count, pool.questions.length) });
  const test = {
    test_id: `${poolName}-${Date.now()}`,
    title: titlePrefix || (poolName === "free" ? "Free Full Test" : "Paid Full Test"),
    pool: poolName,
    examSlug: EXAM_SLUG,
    duration_minutes: timeMinutes,
    negative_marking: 1 / 3,
    marks_per_question: 2,
    instant,
    questions,
  };
  try {
    storeSet("current-test", JSON.stringify(test));
    storeSet("current-state", JSON.stringify({
      answers: {}, flagged: [], current: 0, phase: "taking",
      secondsLeft: timeMinutes ? timeMinutes * 60 : null,
      endsAt: timeMinutes ? Date.now() + timeMinutes * 60000 : null,
      revealed: {},
    }));
  } catch (e) {}
  window.location.href = "test.html";
}

// ============================================================================
// Wrong-question practice (from the account dashboard)
// ============================================================================

/** Builds and launches a test made of exactly the signed-in user's current
 * "wrong" questions for this exam (see getWrongQuestionIds) -- reuses the
 * same sessionStorage handoff to test.html as startTest(), just with a
 * hand-picked question list instead of a stratified sample. No time limit
 * and no negative marking -- this is remediation practice, not a mock exam. */
async function startWrongPracticeTest() {
  const root = document.getElementById("root");
  root.innerHTML = `<p>आपके गलत प्रश्न लोड हो रहे हैं...</p>`;

  const ids = await getWrongQuestionIds(EXAM_SLUG);
  if (!ids.length) {
    root.innerHTML = `<div class="empty-state">बधाई हो! अभी अभ्यास के लिए कोई गलत प्रश्न नहीं है। 🎉<br>
      <a class="btn btn-secondary" href="index.html" style="margin-top:14px;display:inline-block">वापस होम पेज पर जाएं</a></div>`;
    return;
  }

  const idSet = new Set(ids);
  const hasPaidAccess = await checkEntitlement(EXAM_SLUG);
  const [free, paid] = await Promise.all([
    fetchJson("data/pool_free.json"),
    hasPaidAccess ? fetchPaidPool(EXAM_SLUG) : Promise.resolve({ questions: [] }),
  ]);
  const questions = shuffle([...free.questions, ...paid.questions].filter((q) => idSet.has(q.id)));

  const test = {
    test_id: `wrong-practice-${Date.now()}`,
    title: "गलत प्रश्नों का अभ्यास (Wrong Questions Practice)",
    pool: "wrong-practice",
    examSlug: EXAM_SLUG,
    duration_minutes: null,
    negative_marking: 0,
    marks_per_question: 1,
    instant: true,
    questions,
  };
  try {
    storeSet("current-test", JSON.stringify(test));
    storeSet("current-state", JSON.stringify({
      answers: {}, flagged: [], current: 0, phase: "taking", secondsLeft: null, revealed: {},
    }));
  } catch (e) {}
  window.location.href = "test.html";
}

// ============================================================================
// Home page
// ============================================================================

/** Starts a test from an explicit question list (topic quiz, smart practice, ...). */
function startQuestions({ title, questions, timeMinutes = null, instant = false, pool = "free", kind = "custom", mockId = null }) {
  if (!questions.length) { alert("इस चयन के लिए पर्याप्त प्रश्न नहीं मिले।"); return; }
  const test = {
    test_id: `${kind}-${Date.now()}`, examSlug: EXAM_SLUG, title, pool, kind, mockId,
    duration_minutes: timeMinutes, negative_marking: 1 / 3, marks_per_question: 2, instant, questions,
  };
  storeSet("current-test", JSON.stringify(test));
  storeSet("current-state", JSON.stringify({
    answers: {}, flagged: [], current: 0, phase: "taking",
    secondsLeft: timeMinutes ? timeMinutes * 60 : null,
    endsAt: timeMinutes ? Date.now() + timeMinutes * 60000 : null, revealed: {},
  }));
  window.location.href = "test.html";
}

/** n questions from `list`, never-seen ones first (the student's global no-repeat set), then seen ones. */
function pickUnseen(list, n) {
  const seen = getSeen();
  const unseen = shuffle(list.filter((q) => !isSeen(seen, q)));
  const old = shuffle(list.filter((q) => isSeen(seen, q)));
  return unseen.concat(old).slice(0, n);
}

/** Question language: the student's choice (Hindi / English) where both exist, else whichever exists. */
function langOf(q) {
  let pref = "hi";
  try { pref = localStorage.getItem("qlang") || "hi"; } catch (e) {}
  return (pref === "en" ? (q.english || q.hindi) : (q.hindi || q.english));
}

// Test state survives a closed/killed mobile tab: localStorage first, sessionStorage only if the
// quota is exceeded (image-heavy tests can be large).
function storeSet(k, v) {
  try { localStorage.setItem(k, v); try { sessionStorage.removeItem(k); } catch (e) {} }
  catch (e) { try { sessionStorage.setItem(k, v); } catch (e2) {} }
}
function storeGet(k) {
  try { const v = localStorage.getItem(k); if (v !== null) return v; } catch (e) {}
  try { return sessionStorage.getItem(k); } catch (e) { return null; }
}
function storeRemove(k) {
  try { localStorage.removeItem(k); } catch (e) {}
  try { sessionStorage.removeItem(k); } catch (e) {}
}

/** Renders a question stem: one line per printed line, and consecutive "left | right" lines (a
 * pair-matching list) as a real two-column table. */
function formatQuestionHtml(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  const isRow = (l) => l !== undefined && l.includes(" | ");
  // A short fragment between rows is a wrapped line of the row above ("... लोक" / "दल"), not a new line.
  const LABEL = /^\s*[\(\[]?([A-Da-d]|[ivxIVX]{1,4}|[1-9])[\.\)]/;
  const isContinuation = (l, next) => {
    const t = (l || "").trim();
    return t && !t.includes(" | ") && !LABEL.test(t) && ((t.length <= 40 && isRow(next)) || (t.length <= 14 && !/[:।?]$/.test(t)));
  };
  let i = 0;
  while (i < lines.length) {
    if (isRow(lines[i])) {
      const rows = [];
      while (i < lines.length) {
        if (isRow(lines[i])) rows.push(lines[i++].split(" | "));
        else if (rows.length && isContinuation(lines[i], lines[i + 1])) {
          const last = rows[rows.length - 1];
          const k = last.reduce((b, c, j) => (c.length > last[b].length ? j : b), 0);
          last[k] += " " + lines[i++].trim();
        } else break;
      }
      const head = rows.length >= 2 && /सूची|List|Column|स्तम्भ|स्तंभ/i.test(rows[0].join(" "));
      out.push(`<table class="match-table">${rows.map((r, k) =>
        `<tr>${r.map((c) => (head && k === 0 ? `<th>${escapeHtml(c)}</th>` : `<td>${escapeHtml(c)}</td>`)).join("")}</tr>`).join("")}</table>`);
      continue;
    }
    out.push(`<div class="q-line">${escapeHtml(lines[i])}</div>`);
    i++;
  }
  return out.join("");
}

/** Starts a FIXED test (numbered mock or previous-year paper): the question ids are predetermined,
 * so every student gets the same paper and scores are comparable. */
async function startFixedTest({ qids, title, tier, minutesPerQuestion, mockId = null, kind = "mock" }) {
  const free = await fetchJson("data/pool_free.json");
  let pool = free.questions;
  if (tier === "paid") pool = pool.concat((await fetchPaidPool(EXAM_SLUG)).questions);
  const byId = new Map(pool.map((q) => [q.id, q]));
  const questions = qids.map((id) => byId.get(id)).filter(Boolean);
  const minutes = Math.max(10, Math.round(questions.length * minutesPerQuestion));
  const test = {
    test_id: `${tier}-fixed-${Date.now()}`, examSlug: EXAM_SLUG, title, pool: tier, mockId, kind,
    duration_minutes: minutes, negative_marking: 1 / 3, marks_per_question: 2, instant: false, questions,
  };
  storeSet("current-test", JSON.stringify(test));
  storeSet("current-state", JSON.stringify({
    answers: {}, flagged: [], current: 0, phase: "taking",
    secondsLeft: minutes * 60, endsAt: Date.now() + minutes * 60000, revealed: {},
  }));
  window.location.href = "test.html";
}

function formatSchemeDuration(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (!h) return `${m} मिनट`;
  return m ? `${h} घंटे ${m} मिनट` : `${h} घंटे`;
}

export async function renderHome() {
  const root = document.getElementById("root");
  if (new URLSearchParams(location.search).get("practiceWrong") === "1") {
    return startWrongPracticeTest();
  }
  let free, paid, hasPaidAccess, subjectsMeta, scheme, mocks, pyp;
  try {
    [free, paid, hasPaidAccess, subjectsMeta, scheme, mocks, pyp] = await Promise.all([
      fetchJson("data/pool_free.json"),
      fetchJsonOptional("data/pool_paid_meta.json"),
      checkEntitlement(EXAM_SLUG),
      fetchJsonOptional("data/subjects_meta.json"),
      fetchJsonOptional("data/exam_scheme.json"),
      fetchJsonOptional("data/mocks.json"),
      fetchJsonOptional("data/pyp.json"),
    ]);
  } catch (e) {
    root.innerHTML = `<div class="empty-state">Test data नहीं मिला। पहले <code>build_test_series.py</code> चलाएं।</div>`;
    return;
  }

  // The Full Test mirrors THIS exam's real paper (question count + duration), derived
  // from its own PYQs/syllabus by orchestrator_common.derive_exam_scheme() -- not a
  // one-size-fits-all 100Q/2hr. Falls back to that only if the scheme file is missing.
  const FT_COUNT = scheme?.total_questions || 100;
  const FT_MINUTES = scheme?.duration_minutes || 120;
  const ftLabel = `${FT_COUNT} प्रश्न · ${formatSchemeDuration(FT_MINUTES)}`;
  const schemeBox = scheme ? `
    <div class="exam-scheme-box">
      <div class="exam-scheme-title">📋 परीक्षा योजना (Exam Scheme)</div>
      <div class="exam-scheme-grid">
        <div class="exam-scheme-item"><span class="exam-scheme-label">कुल प्रश्न</span><span class="exam-scheme-value">${scheme.total_questions}</span></div>
        <div class="exam-scheme-item"><span class="exam-scheme-label">समय</span><span class="exam-scheme-value">${formatSchemeDuration(scheme.duration_minutes)}${scheme.duration_source === "estimated" ? " (अनुमानित)" : ""}</span></div>
        ${scheme.max_marks ? `<div class="exam-scheme-item"><span class="exam-scheme-label">पूर्णांक</span><span class="exam-scheme-value">${scheme.max_marks}</span></div>` : ""}
        ${scheme.negative_marking_fraction ? `<div class="exam-scheme-item"><span class="exam-scheme-label">ऋणात्मक अंकन</span><span class="exam-scheme-value">${scheme.negative_marking_fraction} प्रति गलत उत्तर</span></div>` : ""}
      </div>
      <p class="exam-scheme-note">प्रश्नों का विषयवार वितरण इस परीक्षा के पिछले वर्षों के वास्तविक प्रश्नपत्रों (PYQ) के अनुसार रखा गया है।</p>
    </div>` : "";

  const freeCountBySubject = {};
  free.questions.forEach((q) => { freeCountBySubject[q.subject] = (freeCountBySubject[q.subject] || 0) + 1; });
  const freeSections = groupSubjectsBySections(Object.keys(free.subject_ratios), subjectsMeta, freeCountBySubject);

  // Only rendered when hasPaidAccess -- the not-entitled case uses the
  // merged .zone-premium block below instead (previously a separate plain
  // "Buy Access" box sat directly above a near-identical premium banner,
  // which read as two redundant strips rather than one clear pitch).
  const paidZoneActions = `
      <div class="action-grid">
        <div class="action-card">
          <div class="action-card-icon">📝</div>
          <div class="action-card-title">Full Test</div>
          <p class="action-card-desc">${ftLabel} · सभी विषय शामिल — असली परीक्षा जैसा अनुभव</p>
          <button class="btn btn-primary btn-block" id="btn-paid-full">Full Test शुरू करें</button>
        </div>
        <div class="action-card">
          <div class="action-card-icon">🎯</div>
          <div class="action-card-title">Custom Test</div>
          <p class="action-card-desc">विषय, प्रश्नों की संख्या और समय सीमा — सब अपनी पसंद से चुनें</p>
          <a class="btn btn-secondary btn-block" href="custom.html?pool=paid">Custom Test बनाएं</a>
        </div>
      </div>`;

  const premiumBanner = hasPaidAccess ? "" : `
    <div class="premium-banner">
      <div class="premium-banner-text">
        <div class="premium-banner-title">⭐ Premium Access — अपनी तैयारी को अगले स्तर पर ले जाएं</div>
        <div class="premium-banner-sub">${(paid?.count ?? 0)}+ प्रश्न · विषयवार टेस्ट · पूर्ण मॉक टेस्ट · Custom Test Builder · विस्तृत स्पष्टीकरण</div>
      </div>
      <button class="btn premium-banner-btn" data-buy-trigger>अभी खरीदें</button>
    </div>`;

  let resumeBanner = "";
  try {
    const t = JSON.parse(storeGet("current-test") || "null");
    const st = JSON.parse(storeGet("current-state") || "null");
    if (t && st && st.phase === "taking" && t.examSlug === EXAM_SLUG && (!st.endsAt || st.endsAt > Date.now())) {
      const done = Object.keys(st.answers || {}).length;
      resumeBanner = `<div class="resume-banner"><div><strong>आपका टेस्ट अधूरा है</strong><br><span>${escapeHtml(t.title)} — ${done}/${t.questions.length} प्रश्न हल किए</span></div>
        <div class="resume-actions"><a class="btn btn-primary" href="test.html">टेस्ट जारी रखें</a><button class="btn btn-secondary" id="btn-discard-test">छोड़ दें</button></div></div>`;
    }
  } catch (e) {}

  const mockBtn = (tier, i, m) => (tier === "free" || hasPaidAccess)
    ? `<button class="mock-btn" data-mock="${tier}:${i}">${escapeHtml(m.title)}</button>`
    : `<button class="mock-btn locked" data-buy-trigger>&#128274; ${escapeHtml(m.title)}</button>`;
  const mocksZone = mocks && (mocks.free.length || mocks.paid.length) ? `
    <div class="zone zone-mocks" id="z-mocks">
      <div class="zone-title">&#128221; पूर्ण-लंबाई मॉक टेस्ट (Full-length Mocks)</div>
      <p class="zone-sub">फ्री मॉक: ${mocks.free_questions_per_mock || 100} प्रश्नों का नमूना। पेड मॉक: असली परीक्षा जैसे ${mocks.questions_per_mock} प्रश्न, वास्तविक विषय-अनुपात और समय — हर मॉक अलग, सभी छात्रों के लिए एक जैसा।</p>
      <div class="mock-grid">${mocks.free.map((m, i) => mockBtn("free", i, m)).join("")}${mocks.paid.map((m, i) => mockBtn("paid", i, m)).join("")}</div>
    </div>` : "";
  const pypZone = pyp && pyp.papers.length ? `
    <div class="zone zone-pyp" id="z-pyp">
      <div class="zone-title">&#128196; पिछले वर्षों के प्रश्न-पत्र (Previous Year Papers) <span class="zone-badge zone-badge-paid">PREMIUM</span></div>
      <p class="zone-sub">असली प्रश्न-पत्र, प्रश्नों के मूल क्रम में (करेंट अफेयर्स को छोड़कर)।</p>
      <div class="pyp-list">${pyp.papers.map((pp, i) => hasPaidAccess
        ? `<button class="pyp-row" data-pyp="${i}"><span>${escapeHtml(pp.title)}</span><span>${pp.available}/${pp.original} प्रश्न</span></button>`
        : `<button class="pyp-row locked" data-buy-trigger><span>&#128274; ${escapeHtml(pp.title)}</span><span>${pp.available}/${pp.original} प्रश्न</span></button>`).join("")}</div>
    </div>` : "";

  root.innerHTML = `
    <div class="exam-page-header">
      <h1 class="exam-page-title">${escapeHtml(EXAM_TITLE)}</h1>
    </div>
    ${schemeBox}
    ${resumeBanner}
    ${premiumBanner}
    <div id="extras-top"></div>
    <div class="zone zone-free" id="z-practice">
      <div class="zone-title"><span class="zone-badge zone-badge-free">FREE</span> Free Practice</div>
      <p class="zone-sub">${free.questions.length} प्रश्नों का पूल — हर बार नया टेस्ट, दोहराव नहीं।</p>
      <div class="action-grid">
        <div class="action-card">
          <div class="action-card-icon">📝</div>
          <div class="action-card-title">Full Test</div>
          <p class="action-card-desc">${ftLabel} · सभी विषय शामिल</p>
          <button class="btn btn-primary btn-block" id="btn-free-full">Full Test शुरू करें</button>
        </div>
        <div class="action-card">
          <div class="action-card-icon">🎯</div>
          <div class="action-card-title">Custom Test</div>
          <p class="action-card-desc">प्रश्नों की संख्या, समय सीमा और विषय खुद चुनें</p>
          <a class="btn btn-secondary btn-block" href="custom.html?pool=free">Custom Test बनाएं</a>
        </div>
      </div>
      ${freeSections.map(({ section, subjects }) => `
        <div class="subject-section">
          <div class="subject-section-title">${escapeHtml(section)}</div>
          <div class="subject-grid">
            ${subjects.map((s) => `
              <div class="subject-card">
                <div class="subject-card-emoji">${subjectEmoji(s.name)}</div>
                <div class="subject-card-name-hi">${escapeHtml(s.nameHindi)}</div>
                ${s.nameHindi !== s.name ? `<div class="subject-card-name-en">${escapeHtml(s.name)}</div>` : ""}
                <div class="subject-card-count">${s.count} प्रश्न</div>
                <button class="btn btn-primary btn-subject" data-subject="${escapeHtml(s.name)}">Practice</button>
              </div>`).join("")}
          </div>
        </div>`).join("")}
    </div>

    ${mocksZone}
    ${pypZone}
    <div id="extras-mid"></div>

    ${hasPaidAccess ? `
    <div class="zone zone-paid">
      <div class="zone-title"><span class="zone-badge zone-badge-paid">PAID</span> Paid Practice</div>
      <p class="zone-sub">${(paid?.count ?? 0)} प्रश्नों का प्रीमियम पूल — विषयवार प्रैक्टिस टेस्ट, पूर्ण मॉक टेस्ट और अपनी पसंद का Custom Test, सबकी सुविधा एक साथ।</p>
      ${paidZoneActions}
    </div>` : `
    <div class="zone zone-premium">
      <div class="zone-title">⭐ Premium Access — अपनी तैयारी को अगले स्तर पर ले जाएं</div>
      <p class="zone-sub premium-desc">
        ${(paid?.count ?? 0)}+ प्रश्नों का प्रीमियम पूल — दो तरीकों से तैयारी करें: हर विषय पर गहराई से पकड़ बनाने के लिए
        <strong>विषयवार प्रैक्टिस टेस्ट</strong>, और असली परीक्षा के माहौल का अनुभव देने के लिए पूरी लंबाई का
        <strong>Full Test (${FT_COUNT} प्रश्न, ${formatSchemeDuration(FT_MINUTES)})</strong> — साथ ही अपनी पसंद के विषय, प्रश्न संख्या और समय सीमा के साथ
        <strong>Custom Test</strong> बनाने की सुविधा भी। हर प्रश्न के साथ विस्तृत स्पष्टीकरण।
      </p>
      <button class="btn premium-banner-btn" data-buy-trigger>⭐ अभी खरीदें (Buy Access)</button>
    </div>`}
  `;

  document.getElementById("btn-free-full").onclick = () =>
    startTest({ poolName: "free", count: FT_COUNT, timeMinutes: FT_MINUTES, instant: false, titlePrefix: "Free Full Test" });
  root.querySelectorAll(".btn-subject").forEach((btn) => {
    btn.onclick = () => startTest({
      poolName: "free", subjects: [btn.dataset.subject], count: 25, timeMinutes: null, instant: true,
      titlePrefix: `${btn.dataset.subject} — Practice`,
    });
  });

  const discard = document.getElementById("btn-discard-test");
  if (discard) discard.onclick = () => { storeRemove("current-test"); storeRemove("current-state"); location.reload(); };
  const launch = async (btn, args) => {
    const label = btn.innerHTML;
    btn.disabled = true; btn.textContent = "लोड हो रहा है...";
    try { await startFixedTest({ ...args, minutesPerQuestion: FT_MINUTES / FT_COUNT }); }
    catch (e) { btn.disabled = false; btn.innerHTML = label; alert("टेस्ट लोड नहीं हो सका। कृपया दोबारा कोशिश करें।"); }
  };
  root.querySelectorAll("[data-mock]").forEach((btn) => {
    btn.onclick = () => {
      const [tier, idx] = btn.dataset.mock.split(":");
      const m = mocks[tier][Number(idx)];
      launch(btn, { qids: m.qids, title: m.title, tier, mockId: m.id, kind: "mock" });
    };
  });
  root.querySelectorAll("[data-pyp]").forEach((btn) => {
    btn.onclick = () => {
      const pp = pyp.papers[Number(btn.dataset.pyp)];
      launch(btn, { qids: pp.qids, title: pp.title, tier: "paid", mockId: `pyp-${Number(btn.dataset.pyp) + 1}`, kind: "pyp" });
    };
  });

  if (hasPaidAccess) {
    document.getElementById("btn-paid-full").onclick = () =>
      startTest({ poolName: "paid", count: FT_COUNT, timeMinutes: FT_MINUTES, instant: false, titlePrefix: "Paid Full Test" });
  } else {
    // Three buttons can trigger a purchase: the paid zone's own "Buy Access"
    // and both premium-banner buttons (top and bottom of the page) -- all
    // wired to the same flow.
    root.querySelectorAll("[data-buy-trigger]").forEach((btn) => {
      btn.onclick = () => openDurationPicker({ examSlug: EXAM_SLUG, examTitle: EXAM_TITLE }, (months) => {
        btn.disabled = true;
        const originalText = btn.textContent;
        buyAccess(EXAM_SLUG, EXAM_TITLE, {
          durationMonths: months,
          onProcessing: () => { btn.textContent = "भुगतान प्रोसेस हो रहा है... कुछ सेकंड बाद पेज रीफ़्रेश करें।"; },
          onError: () => { btn.disabled = false; btn.textContent = originalText; alert("भुगतान शुरू नहीं हो सका। कृपया दोबारा कोशिश करें।"); },
        });
      });
    });
  }

  // Learning tools (recommendations, sectional tests, topic quizzes, search, flashcards, planner, leaderboard ...)
  let nextExamDate = "";
  try { nextExamDate = (await loadCalendar()).filter((e) => e.slug === EXAM_SLUG)[0]?.date || ""; } catch (e) {}
  try {
    await mountHomeExtras({
      root, examSlug: EXAM_SLUG, examTitle: EXAM_TITLE, free, paid, hasPaidAccess, scheme, subjectsMeta, mocks, pyp,
      FT_COUNT, FT_MINUTES, nextExamDate, fetchPaidPool, startTest, startQuestions, pickUnseen,
    });
  } catch (e) { console.warn("Extras failed to load (core practice still works):", e); }
  checkReminderTick();

  document.getElementById("reset-progress")?.addEventListener("click", () => {
    if (confirm("क्या आप वाकई अपनी पूरी प्रोग्रेस रीसेट करना चाहते हैं?")) { resetAllProgress(); location.reload(); }
  });
}

// ============================================================================
// Custom test builder -- works for either pool via ?pool=free / ?pool=paid
// (default "paid" for old links). Only the paid pool is entitlement-gated.
// ============================================================================

const COUNT_PRESETS = [10, 25, 50, 100];
const TIME_PRESETS = [
  { minutes: 0, label: "असीमित" },
  { minutes: 15, label: "15 मिनट" },
  { minutes: 30, label: "30 मिनट" },
  { minutes: 60, label: "60 मिनट" },
];

function presetRow(id, items, defaultIndex) {
  return `<div class="preset-row" id="${id}">
    ${items.map((item, i) => `<button type="button" class="preset-btn${i === defaultIndex ? " active" : ""}" data-value="${item.value}">${item.label}</button>`).join("")}
  </div>`;
}

function wirePresetRow(id) {
  const row = document.getElementById(id);
  row.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.onclick = () => {
      row.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    };
  });
}

function presetValue(id) {
  return document.querySelector(`#${id} .preset-btn.active`).dataset.value;
}

export async function renderCustomBuilder() {
  const root = document.getElementById("root");
  const pool = new URLSearchParams(location.search).get("pool") === "free" ? "free" : "paid";

  if (pool === "paid") {
    const hasPaidAccess = await checkEntitlement(EXAM_SLUG);
    if (!hasPaidAccess) {
      root.innerHTML = `
        <div class="zone zone-paid">
          <div class="zone-title"><span class="zone-badge zone-badge-paid">PAID</span> Custom Test — Paid Feature</div>
          <p class="zone-sub">Custom Test Builder का Paid पूल केवल Paid Access के साथ उपलब्ध है। मुफ़्त पूल से Custom Test बनाने के लिए वापस होम पेज पर जाएं।</p>
          <div class="zone-actions">
            <button class="btn btn-primary" id="btn-buy-access">Access खरीदें (Buy Access)</button>
            <a class="btn btn-secondary" href="index.html">होम पर वापस जाएं</a>
          </div>
        </div>`;
      document.getElementById("btn-buy-access").onclick = (e) => {
        const btn = e.currentTarget;
        buyAccess(EXAM_SLUG, EXAM_TITLE, {
          onProcessing: () => {
            btn.disabled = true;
            btn.textContent = "भुगतान प्रोसेस हो रहा है... कुछ सेकंड बाद पेज रीफ़्रेश करें।";
          },
          onError: () => alert("भुगतान शुरू नहीं हो सका। कृपया दोबारा कोशिश करें।"),
        });
      };
      return;
    }
  }

  let poolData;
  try {
    poolData = pool === "paid" ? await fetchPaidPool(EXAM_SLUG) : await fetchJson(`data/pool_${pool}.json`);
  } catch (e) {
    root.innerHTML = `<div class="empty-state">Test data नहीं मिला। <a href="index.html">होम पर जाएं</a></div>`;
    return;
  }
  const countBySubject = {};
  poolData.questions.forEach((q) => { countBySubject[q.subject] = (countBySubject[q.subject] || 0) + 1; });
  const subjectsMeta = await fetchJsonOptional("data/subjects_meta.json");
  const sections = groupSubjectsBySections(Object.keys(poolData.subject_ratios), subjectsMeta, countBySubject);

  root.innerHTML = `
    <div class="zone-title" style="margin-bottom:16px">
      <span class="zone-badge zone-badge-${pool}">${pool === "free" ? "FREE" : "PAID"}</span> Custom Test बनाएं
    </div>
    <div class="form-block">
      <div class="form-label-row">
        <span class="form-label">विषय चुनें (Select subjects)</span>
        <div class="select-all-row">
          <button type="button" class="link-btn" id="btn-select-all">सभी चुनें</button>
          <button type="button" class="link-btn" id="btn-deselect-all">सभी हटाएं</button>
        </div>
      </div>
      ${sections.map(({ section, subjects }) => `
        <div class="subject-section">
          <div class="subject-section-title">${escapeHtml(section)}</div>
          <div class="subject-checks">
            ${subjects.map((s) => `
              <label class="subject-check checked">
                <input type="checkbox" value="${escapeHtml(s.name)}" checked>
                <span>${subjectLabel(s)}</span>
                <span class="cnt">${s.count}</span>
              </label>`).join("")}
          </div>
        </div>`).join("")}
    </div>

    <div class="form-block field-row">
      <div class="field">
        <label>प्रश्नों की संख्या (Question count)</label>
        ${presetRow("count-presets", COUNT_PRESETS.map((n) => ({ value: n, label: n })), 1)}
      </div>
      <div class="field">
        <label>समय सीमा (Time limit)</label>
        ${presetRow("time-presets", TIME_PRESETS.map((t) => ({ value: t.minutes, label: t.label })), 1)}
      </div>
    </div>

    <div class="form-block toggle-row">
      <div>
        <div class="t-label">तुरंत उत्तर व स्पष्टीकरण (Instant reveal)</div>
        <div class="t-hint">हर प्रश्न के तुरंत बाद सही उत्तर व स्पष्टीकरण देखें</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="f-instant">
        <span class="track"></span>
      </label>
    </div>

    <button class="btn btn-primary btn-block" id="btn-start-custom">Test शुरू करें</button>
  `;

  root.querySelectorAll(".subject-check input").forEach((cb) => {
    cb.addEventListener("change", () => cb.closest(".subject-check").classList.toggle("checked", cb.checked));
  });
  function setAllSubjects(checked) {
    root.querySelectorAll(".subject-check input").forEach((cb) => {
      cb.checked = checked;
      cb.closest(".subject-check").classList.toggle("checked", checked);
    });
  }
  document.getElementById("btn-select-all").onclick = () => setAllSubjects(true);
  document.getElementById("btn-deselect-all").onclick = () => setAllSubjects(false);
  wirePresetRow("count-presets");
  wirePresetRow("time-presets");

  document.getElementById("btn-start-custom").onclick = () => {
    const selected = Array.from(root.querySelectorAll(".subject-check input:checked")).map((cb) => cb.value);
    if (selected.length === 0) { alert("कम से कम एक विषय चुनें"); return; }
    const count = Number(presetValue("count-presets"));
    const timeVal = Number(presetValue("time-presets"));
    const instant = document.getElementById("f-instant").checked;
    startTest({
      poolName: pool, subjects: selected, count, timeMinutes: timeVal > 0 ? timeVal : null, instant,
      titlePrefix: `Custom Test${pool === "free" ? " (Free)" : ""}`,
    });
  };
}

// ============================================================================
// Test player
// ============================================================================

let TEST = null;
let STATE = null;
let timerHandle = null;
let questionStartedAt = Date.now();

function saveState() {
  try {
    storeSet("current-state", JSON.stringify({ ...STATE, flagged: Array.from(STATE.flagged) }));
  } catch (e) {}
}

/** Adds time spent on the current question (since the last navigation, or
 * since this page view started) into STATE.questionTimes, then resets the
 * clock -- called right before STATE.current changes (prev/next/palette)
 * and at submit, so every question's viewing time gets attributed to it
 * rather than lumped into whichever question happens to be showing when
 * the test ends. */
function recordTimeSpent() {
  if (!TEST || STATE.phase !== "taking") return;
  const q = currentQuestion();
  if (!q) return;
  const elapsed = (Date.now() - questionStartedAt) / 1000;
  STATE.questionTimes[q.id] = (STATE.questionTimes[q.id] || 0) + elapsed;
  questionStartedAt = Date.now();
}

let keysBound = false;
function bindExamKeys() {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener("keydown", (e) => {
    if (!TEST || !STATE || STATE.phase !== "taking" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const q = currentQuestion();
    const revealed = !!(TEST.instant && STATE.revealed[q.id]);
    if (/^[1-4]$/.test(e.key) && !revealed) { document.querySelector(`.option[data-opt="${e.key}"]`)?.click(); }
    else if (e.key === "ArrowRight" || e.key === "n" || e.key === "N") document.getElementById("btn-next")?.click();
    else if (e.key === "ArrowLeft" || e.key === "p" || e.key === "P") document.getElementById("btn-prev")?.click();
    else if (e.key === "f" || e.key === "F") document.getElementById("btn-flag")?.click();
    else if (e.key === "b" || e.key === "B") document.getElementById("btn-bm")?.click();
  });
}

export async function renderTest() {
  bindExamKeys();
  let rawTest, rawState;
  try {
    rawTest = storeGet("current-test");
    rawState = storeGet("current-state");
  } catch (e) {}
  if (!rawTest) { showLoadError(); return; }

  TEST = JSON.parse(rawTest);
  const parsed = rawState ? JSON.parse(rawState) : null;
  STATE = parsed
    ? { ...parsed, flagged: new Set(parsed.flagged || []), questionTimes: parsed.questionTimes || {} }
    : { answers: {}, flagged: new Set(), current: 0, phase: "taking",
        secondsLeft: TEST.duration_minutes ? TEST.duration_minutes * 60 : null, revealed: {}, questionTimes: {} };

  if (TEST.examSlug && TEST.examSlug !== EXAM_SLUG) { showLoadError(); return; }
  document.title = TEST.title + " — Test Series";
  document.getElementById("test-title").textContent = TEST.title;
  questionStartedAt = Date.now();
  if (STATE.endsAt && STATE.phase === "taking") {
    // The clock is an absolute deadline, so time keeps running correctly while the tab was closed or throttled.
    STATE.secondsLeft = Math.max(0, Math.round((STATE.endsAt - Date.now()) / 1000));
    if (STATE.secondsLeft <= 0) { submitTest(); return; }
  }

  if (TEST.duration_minutes && STATE.phase === "taking") startTimer();

  if (STATE.phase === "results") renderResults();
  else renderQuestion();
}

function showLoadError() {
  document.getElementById("player-root").innerHTML =
    `<div class="empty-state">कोई टेस्ट नहीं मिला। <a href="index.html">होम पर जाएं</a></div>`;
}

function startTimer() {
  clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    if (STATE.endsAt) STATE.secondsLeft = Math.max(0, Math.round((STATE.endsAt - Date.now()) / 1000));
    else STATE.secondsLeft -= 1;
    updateTimerDisplay();
    if (STATE.secondsLeft <= 0) { clearInterval(timerHandle); submitTest(); }
    saveState();
  }, 1000);
}

function updateTimerDisplay() {
  const el = document.getElementById("timer");
  if (!el || STATE.secondsLeft == null) return;
  const m = Math.floor(STATE.secondsLeft / 60), s = STATE.secondsLeft % 60;
  el.textContent = `${m}:${String(s).padStart(2, "0")}`;
  el.classList.toggle("low", STATE.secondsLeft <= 120);
}

function currentQuestion() { return TEST.questions[STATE.current]; }

function renderQuestion() {
  const q = currentQuestion();
  const total = TEST.questions.length;
  const langData = langOf(q);
  const revealed = !!(TEST.instant && STATE.revealed[q.id]);
  const bothLangs = TEST.questions.some((x) => x.hindi && x.english);

  const root = document.getElementById("player-root");
  root.innerHTML = `
    <div class="player-topbar">
      ${TEST.instant ? `<span class="badge-instant">Instant Mode</span>` : ""}
      <div style="flex:1"></div>
      ${TEST.duration_minutes ? `<div class="timer" id="timer"></div>` : ""}
      ${bothLangs ? `<button class="fx-mini" id="btn-lang" title="प्रश्न की भाषा">हिं / EN</button>` : ""}
      <button class="fx-mini" id="btn-full" title="फ़ुल-स्क्रीन एग्ज़ाम मोड">&#x26F6;</button>
      <div>${STATE.current + 1} / ${total}</div>
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:${((STATE.current + 1) / total) * 100}%"></div></div>
    <div class="player-actions">
      <button class="reset-btn" id="btn-reset"><span class="reset-icon">&#8634;</span> टेस्ट रीसेट करें</button>
      <button class="flag-btn ${STATE.flagged.has(q.id) ? "is-flagged" : ""}" id="btn-flag" aria-pressed="${STATE.flagged.has(q.id)}">
        <span class="flag-icon">&#9873;</span>
        <span>${STATE.flagged.has(q.id) ? "फ़्लैग हटाएं" : "बाद में देखने के लिए फ़्लैग करें"}</span>
      </button>
    </div>

    <div class="qnum-palette" id="qnum-palette"></div>

    <div class="question-card">
      <div class="question-tags">
        ${q.subject ? `<span class="pill pill-subject">${escapeHtml(q.subject)}</span>` : ""}
        <button class="fx-bm ${isBookmarked(EXAM_SLUG, q.id) ? "on" : ""}" id="btn-bm" title="बुकमार्क">${isBookmarked(EXAM_SLUG, q.id) ? "★" : "☆"}</button>
      </div>
      ${q.image
        ? `<img class="q-image" src="${q.image}" alt="प्रश्न ${STATE.current + 1} (चित्र सहित)"><div class="q-image-note">प्रश्न ${STATE.current + 1} — सही विकल्प नीचे चुनें</div>`
        : `<div class="question-text">प्रश्न ${STATE.current + 1}. ${formatQuestionHtml(langData.question)}</div>`}
      <div id="options"></div>
      ${revealed && langData.explanation ? `<div class="explanation-box"><strong>स्पष्टीकरण:</strong> ${escapeHtml(langData.explanation)}</div>` : ""}
      <div class="report-row"><button class="report-btn" id="btn-report">&#9888; इस प्रश्न में त्रुटि बताएं</button></div>
    </div>

    <div class="nav-bar nav-bar-3">
      <button class="btn nav-btn nav-prev" id="btn-prev" ${STATE.current === 0 ? "disabled" : ""}><span class="nav-ico">&larr;</span> पिछला</button>
      <button class="btn nav-btn nav-submit" id="btn-submit-now"><span class="nav-ico">&#10003;</span> सबमिट</button>
      <button class="btn nav-btn nav-next" id="btn-next" ${STATE.current === total - 1 ? "disabled" : ""}>अगला <span class="nav-ico">&rarr;</span></button>
    </div>
  `;

  renderOptions(q, langData, revealed);
  renderPalette();
  if (TEST.duration_minutes) updateTimerDisplay();

  document.getElementById("btn-prev").onclick = () => { recordTimeSpent(); STATE.current--; saveState(); renderQuestion(); };
  document.getElementById("btn-flag").onclick = () => {
    if (STATE.flagged.has(q.id)) STATE.flagged.delete(q.id); else STATE.flagged.add(q.id);
    saveState(); renderQuestion();
  };
  document.getElementById("btn-next").onclick = () => { recordTimeSpent(); STATE.current++; saveState(); renderQuestion(); };
  // Submit and Reset live in the bottom bar on every question, in every kind of test
  // (full, subject practice, custom, paid).
  document.getElementById("btn-submit-now").onclick = () => {
    const unanswered = TEST.questions.filter((x) => STATE.answers[x.id] == null).length;
    const note = unanswered ? `⚠ ${unanswered} प्रश्न अभी अनुत्तरित हैं।

` : "";
    if (confirm(`${note}क्या आप वाकई टेस्ट सबमिट करना चाहते हैं?
सबमिट करने के बाद उत्तर नहीं बदले जा सकते।`)) submitTest();
  };
  document.getElementById("btn-report").onclick = async () => {
    const reason = prompt("क्या समस्या है?\n1 = उत्तर गलत है\n2 = प्रश्न/विकल्प अधूरे या गलत दिख रहे हैं\n3 = अन्य\n(केवल संख्या लिखें)");
    if (!reason) return;
    const note = prompt("अगर चाहें तो संक्षेप में लिखें (वैकल्पिक):") || "";
    const ok = await reportMistake(EXAM_SLUG, q, ({ "1": "wrong_answer", "2": "bad_rendering", "3": "other" })[reason.trim()] || "other", note);
    alert(ok ? "धन्यवाद! हम इसकी जाँच करेंगे।" : "अभी रिपोर्ट नहीं भेजी जा सकी। कृपया बाद में कोशिश करें।");
  };
  document.getElementById("btn-bm").onclick = async (e) => {
    const btn = e.currentTarget;   // (currentTarget is null after an await)
    const on = await toggleBookmark(EXAM_SLUG, q);
    btn.textContent = on ? "★" : "☆"; btn.classList.toggle("on", on);
  };
  document.getElementById("btn-lang")?.addEventListener("click", () => {
    try { localStorage.setItem("qlang", (localStorage.getItem("qlang") || "hi") === "hi" ? "en" : "hi"); } catch (e) {}
    renderQuestion();
  });
  document.getElementById("btn-full").onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.();
  };
  document.getElementById("btn-reset").onclick = () => {
    if (confirm("क्या आप वाकई टेस्ट रीसेट करना चाहते हैं?\nआपके सभी उत्तर मिट जाएंगे और टाइमर फिर से शुरू होगा।")) resetTest();
  };
}

/** Restarts THIS test from scratch -- same questions, answers/flags/reveals cleared, full
 * timer. Nothing is marked seen (that only happens on Submit), so a reset costs the student
 * none of their fresh questions. */
function resetTest() {
  clearInterval(timerHandle);
  STATE = {
    answers: {}, flagged: new Set(), current: 0, phase: "taking",
    secondsLeft: TEST.duration_minutes ? TEST.duration_minutes * 60 : null,
    endsAt: TEST.duration_minutes ? Date.now() + TEST.duration_minutes * 60000 : null,
    revealed: {}, questionTimes: {},
  };
  questionStartedAt = Date.now();
  saveState();
  if (TEST.duration_minutes) startTimer();
  renderQuestion();
}

function renderOptions(q, langData, revealed) {
  const el = document.getElementById("options");
  const selected = STATE.answers[q.id];
  el.innerHTML = langData.options.map((opt, i) => {
    const n = i + 1;
    let cls = "option";
    if (revealed) {
      cls += " locked";
      if (n === q.correct_option) cls += " reveal-correct";
      else if (n === selected && n !== q.correct_option) cls += " reveal-wrong";
    } else if (selected === n) {
      cls += " selected";
    }
    return `<div class="${cls}" data-opt="${n}"><span class="option-letter">${n}</span><span>${escapeHtml(opt)}</span></div>`;
  }).join("");
  if (!revealed) {
    el.querySelectorAll(".option").forEach((optEl) => {
      optEl.onclick = () => {
        STATE.answers[q.id] = Number(optEl.dataset.opt);
        if (TEST.instant) STATE.revealed[q.id] = true;
        saveState();
        renderQuestion();
      };
    });
  }
}

function renderPalette() {
  const el = document.getElementById("qnum-palette");
  el.innerHTML = TEST.questions.map((q, i) => {
    const classes = ["qnum"];
    if (i === STATE.current) classes.push("current");
    if (STATE.answers[q.id] != null) classes.push("answered");
    if (STATE.flagged.has(q.id)) classes.push("flagged");
    return `<button class="${classes.join(" ")}" data-idx="${i}">${i + 1}</button>`;
  }).join("");
  el.querySelectorAll(".qnum").forEach((btn) => {
    btn.onclick = () => { recordTimeSpent(); STATE.current = Number(btn.dataset.idx); saveState(); renderQuestion(); };
  });
}

function formatDuration(totalSeconds) {
  const s = Math.round(totalSeconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}मि ${sec}से` : `${sec}से`;
}

function computeTimeStats() {
  const totalTime = TEST.questions.reduce((sum, q) => sum + (STATE.questionTimes[q.id] || 0), 0);
  const avgTime = TEST.questions.length ? totalTime / TEST.questions.length : 0;
  return { totalTime, avgTime };
}

function submitTest() {
  recordTimeSpent(); // attribute time spent on whichever question was showing when submitted
  clearInterval(timerHandle);
  STATE.phase = "results";
  // Only questions the student actually reached count as seen -- an early Submit must not
  // burn the questions they never opened.
  const reached = TEST.questions.filter((q) => STATE.answers[q.id] != null || (STATE.questionTimes[q.id] || 0) > 0);
  addSeen(reached);
  saveCloudSeenKeys(reached.map(questionSeenKey)); // fire-and-forget; best-effort for signed-in students
  saveState();
  const r = scoreTest();
  recordAttempt(EXAM_SLUG, {
    testId: TEST.test_id,
    title: TEST.title,
    pool: TEST.pool,
    questionCount: TEST.questions.length,
    correct: r.correct,
    wrong: r.wrong,
    skipped: r.skipped,
    score: r.score,
    accuracy: r.accuracy,
    bySubject: r.bySubject,
    wrongIds: r.wrongIds,
    fixedIds: r.fixedIds,
  });
  renderResults();
}

function scoreTest() {
  let correct = 0, wrong = 0, skipped = 0;
  const bySubject = {};
  const wrongIds = [], fixedIds = [];
  for (const q of TEST.questions) {
    const given = STATE.answers[q.id];
    const subj = q.subject || "(Unclassified)";
    bySubject[subj] ??= { correct: 0, total: 0 };
    bySubject[subj].total++;
    if (given == null) { skipped++; continue; }
    if (given === q.correct_option) { correct++; bySubject[subj].correct++; fixedIds.push(q.id); }
    else { wrong++; wrongIds.push(q.id); }
  }
  const marks = TEST.marks_per_question || 1;
  const neg = TEST.negative_marking || 0;
  const score = correct * marks - wrong * marks * neg;
  const scored = correct + wrong;
  return { correct, wrong, skipped, score, bySubject, wrongIds, fixedIds, accuracy: scored ? Math.round((correct / scored) * 100) : 0 };
}

function renderResults() {
  const r = scoreTest();
  const t = computeTimeStats();
  const root = document.getElementById("player-root");

  const subjectRows = Object.keys(r.bySubject).sort().map((s) => {
    const d = r.bySubject[s];
    const pct = d.total ? Math.round((d.correct / d.total) * 100) : 0;
    return `
      <div class="subject-bar-row">
        <span class="label">${escapeHtml(s)}</span>
        <div class="subject-bar-track"><div class="subject-bar-fill" style="width:${pct}%"></div></div>
        <span class="frac">${d.correct}/${d.total}</span>
      </div>`;
  }).join("");

  const reviewList = TEST.questions.map((q, i) => {
    const langData = langOf(q);
    const given = STATE.answers[q.id];
    return `
      <div class="question-card" data-qi="${i}" id="rq-${i}">
        <div class="question-tags">
          ${q.subject ? `<span class="pill pill-subject">${escapeHtml(q.subject)}</span>` : ""}
          <span class="pill pill-time">⏱ ${formatDuration(STATE.questionTimes[q.id] || 0)}</span>
        </div>
        <div class="question-text">प्रश्न ${i + 1}. ${formatQuestionHtml(langData.question)}</div>
        <div>${langData.options.map((opt, j) => {
          const n = j + 1;
          let cls = "option locked";
          if (n === q.correct_option) cls += " reveal-correct";
          else if (n === given && n !== q.correct_option) cls += " reveal-wrong";
          return `<div class="${cls}"><span class="option-letter">${n}</span><span>${escapeHtml(opt)}</span></div>`;
        }).join("")}</div>
        ${given == null ? `<p style="color:var(--text-dim);font-size:0.85rem">आपने यह प्रश्न छोड़ दिया।</p>` : ""}
        ${langData.explanation ? `<div class="explanation-box"><strong>स्पष्टीकरण:</strong> ${escapeHtml(langData.explanation)}</div>` : ""}
      </div>`;
  }).join("");

  root.innerHTML = `
    <div class="score-hero">
      <div class="big">${r.score.toFixed(2)}</div>
      <div style="color:var(--text-dim)">अंक (marks)</div>
      <div class="stat-row">
        <div class="stat"><div class="n" style="color:var(--success)">${r.correct}</div><div class="l">सही</div></div>
        <div class="stat"><div class="n" style="color:var(--danger)">${r.wrong}</div><div class="l">गलत</div></div>
        <div class="stat"><div class="n">${r.skipped}</div><div class="l">छोड़े</div></div>
        <div class="stat"><div class="n">${r.accuracy}%</div><div class="l">Accuracy</div></div>
        <div class="stat"><div class="n">${formatDuration(t.totalTime)}</div><div class="l">कुल समय</div></div>
        <div class="stat"><div class="n">${formatDuration(t.avgTime)}</div><div class="l">औसत/प्रश्न</div></div>
      </div>
    </div>

    <div class="section-title">विषयवार प्रदर्शन (Subject-wise)</div>
    ${subjectRows}
    <p class="no-repeat-note">देखे गए प्रश्न अगली बार दोबारा नहीं आएंगे, जब तक पूल खत्म न हो जाए।</p>
    <div id="results-extras"></div>

    <div class="section-title" style="margin-top:26px">समीक्षा (Review)</div>
    ${reviewList}

    <a href="index.html" class="btn btn-primary btn-block" style="margin-top:20px">होम पर वापस जाएं</a>
  `;
  const ctx = { examSlug: EXAM_SLUG, examTitle: EXAM_TITLE, TEST, STATE, r, t };
  renderResultsExtras(root.querySelector("#results-extras"), ctx).catch((e) => console.warn("Result extras failed:", e));
  enhanceReview(root, ctx);
}
