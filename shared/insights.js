// Result-page analytics + exam-page learning tools, shared by every exam site.
// app.js calls two entry points:  renderResultsExtras(mount, ctx)  and  mountHomeExtras(ctx).
// All user data goes through userdata.js / community.js (local-first, cloud-synced when signed in).

import {
  recordStats, loadStats, weakTopics, addHistory, getHistory, mockSummary, toggleBookmark, isBookmarked, setNote, getBookmarksLocal,
  BADGES, getGam, syncGam, levelOf, awardAfterTest, getPlan, setPlan, syncPlans, todayCount, daysLeft, questionSnapshot,
} from "./userdata.js?v=2";
import { submitScore, getRank, topScores, loadComments, postComment, deleteComment, getDisplayName, setDisplayName } from "./community.js?v=1";
import { getCurrentUser, authReady, showAuthModal } from "./auth.js?v=4";
import { PAID_PDF_URL } from "./firebase-config.js?v=2";

// Load the feature stylesheet on every page that uses these tools (root-absolute: works on the live domain and the local preview alike).
(() => { if (!document.querySelector('link[data-fx-css]')) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/shared/features.css?v=2"; l.dataset.fxCss = "1"; document.head.appendChild(l); } })();

const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Shortens question text for a list without cutting a $formula$ in half (or an escaped &entity;): clip first, escape after.
const clipMath = (s, n) => { s = String(s ?? ""); if (s.length <= n) return s; let t = s.slice(0, n); if ((t.match(/\$/g) || []).length % 2) t = t.slice(0, t.lastIndexOf("$")); return t; };
const NL = String.fromCharCode(10);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const fmtT = (sec) => { const s = Math.round(sec); const m = Math.floor(s / 60); return m > 0 ? `${m}मि ${s % 60}से` : `${s}से`; };
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const bar = (p, cls = "") => `<div class="mini-bar"><div class="mini-bar-fill ${cls}" style="width:${Math.max(2, p)}%"></div></div>`;
const accClass = (p) => (p >= 70 ? "good" : p >= 45 ? "mid" : "bad");

function modal(html, onClose) {
  const ov = document.createElement("div");
  ov.className = "fx-overlay";
  ov.innerHTML = `<div class="fx-modal"><button class="fx-close" aria-label="close">&times;</button>${html}</div>`;
  const close = () => { ov.remove(); onClose?.(); };
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.querySelector(".fx-close").onclick = close;
  document.body.appendChild(ov);
  return { el: ov.querySelector(".fx-modal"), close };
}

// ============================================================================ RESULTS PAGE
function topicRowsFromTest(TEST, STATE) {
  const by = {};
  for (const q of TEST.questions) {
    const key = `${q.subject || "Other"}||${q.topic || ""}`;
    const d = (by[key] ??= { subject: q.subject || "Other", topic: q.topic || "", c: 0, w: 0, k: 0, s: 0 });
    const g = STATE.answers[q.id];
    d.s += STATE.questionTimes[q.id] || 0;
    if (g == null) d.k++; else if (g === q.correct_option) d.c++; else d.w++;
  }
  return Object.values(by);
}

function timeBuckets(TEST, STATE) {
  const defs = [["< 15 सेकंड", 0, 15], ["15–45 सेकंड", 15, 45], ["45–90 सेकंड", 45, 90], ["90+ सेकंड", 90, 1e9]];
  return defs.map(([label, lo, hi]) => {
    const qs = TEST.questions.filter((q) => { const t = STATE.questionTimes[q.id] || 0; return t >= lo && t < hi; });
    const ans = qs.filter((q) => STATE.answers[q.id] != null);
    const ok = ans.filter((q) => STATE.answers[q.id] === q.correct_option);
    return { label, n: qs.length, answered: ans.length, acc: pct(ok.length, ans.length) };
  });
}

function insightLines(TEST, STATE, r, topics) {
  const lines = [];
  const subj = Object.entries(r.bySubject).filter(([, d]) => d.total >= 3).map(([s, d]) => ({ s, p: pct(d.correct, d.total), n: d.total }));
  if (subj.length >= 2) {
    subj.sort((a, b) => b.p - a.p);
    lines.push(`💪 सबसे मज़बूत विषय: <b>${E(subj[0].s)}</b> (${subj[0].p}%) · 🎯 सबसे कमज़ोर: <b>${E(subj[subj.length - 1].s)}</b> (${subj[subj.length - 1].p}%)`);
  }
  const marks = TEST.marks_per_question || 1, neg = TEST.negative_marking || 0;
  if (r.wrong && neg) lines.push(`➖ ${r.wrong} गलत उत्तरों से <b>${(r.wrong * marks * neg).toFixed(2)} अंक</b> कटे। जिन प्रश्नों पर पक्का भरोसा न हो, उन्हें छोड़ना बेहतर हो सकता है।`);
  const quickWrong = TEST.questions.filter((q) => { const g = STATE.answers[q.id]; return g != null && g !== q.correct_option && (STATE.questionTimes[q.id] || 0) < 10; }).length;
  if (quickWrong >= 3) lines.push(`⚡ ${quickWrong} गलत उत्तर 10 सेकंड से कम में दिए गए — जल्दबाज़ी या अनुमान। विकल्प ध्यान से पढ़ें।`);
  const slowRight = TEST.questions.filter((q) => STATE.answers[q.id] === q.correct_option && (STATE.questionTimes[q.id] || 0) > 90).length;
  if (slowRight >= 2) lines.push(`🐢 ${slowRight} सही उत्तरों में 90 सेकंड से ज़्यादा लगे — इन टॉपिक की रिवीज़न से समय बचेगा।`);
  if (r.skipped > TEST.questions.length * 0.25) lines.push(`⏭ ${r.skipped} प्रश्न छोड़े गए (${pct(r.skipped, TEST.questions.length)}%)। ऋणात्मक अंकन न हो तो अनुमान लगाना फ़ायदेमंद रहता है।`);
  const weak = topics.filter((x) => x.topic && x.c + x.w >= 2).map((x) => ({ ...x, p: pct(x.c, x.c + x.w) })).sort((a, b) => a.p - b.p)[0];
  if (weak && weak.p < 60) lines.push(`📚 पहले <b>${E(weak.topic)}</b> (${E(weak.subject)}) दोहराएं — इस टेस्ट में ${weak.p}% सही।`);
  return lines;
}

async function drawScorecard(ctx, r, t, rank) {
  const c = document.createElement("canvas");
  c.width = 1080; c.height = 1350;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 1080, 1350);
  grad.addColorStop(0, "#a855f7"); grad.addColorStop(0.55, "#f472b6"); grad.addColorStop(1, "#fde047");
  g.fillStyle = grad; g.fillRect(0, 0, 1080, 1350);
  g.fillStyle = "#ffffff"; g.beginPath(); g.roundRect(60, 200, 960, 1010, 36); g.fill();
  const font = (px, w = 700) => `${w} ${px}px 'Noto Sans Devanagari','Nirmala UI','Segoe UI',sans-serif`;
  g.fillStyle = "#201a2b"; g.textAlign = "center";
  g.font = font(44); g.fillText("RAJ G.K. GURU", 540, 110);
  g.font = font(28, 500); g.fillText("ALDHRU ACADEMY · Test Series", 540, 156);
  g.font = font(38); g.fillText(ctx.examTitle.slice(0, 44), 540, 290);
  g.font = font(30, 500); g.fillStyle = "#6b6178"; g.fillText(ctx.TEST.title.slice(0, 48), 540, 340);
  g.fillStyle = "#9333ea"; g.font = font(190, 800); g.fillText(r.score.toFixed(1), 540, 560);
  g.fillStyle = "#6b6178"; g.font = font(30, 500); g.fillText("अंक (marks)", 540, 610);
  const stats = [["सही", r.correct, "#15803d"], ["गलत", r.wrong, "#c1272d"], ["छोड़े", r.skipped, "#6b6178"], ["Accuracy", r.accuracy + "%", "#9333ea"]];
  stats.forEach(([l, v, col], i) => { const x = 210 + i * 220; g.fillStyle = col; g.font = font(64, 800); g.fillText(String(v), x, 750); g.fillStyle = "#6b6178"; g.font = font(26, 500); g.fillText(l, x, 795); });
  if (rank) {
    g.fillStyle = "#f3e8ff"; g.beginPath(); g.roundRect(140, 850, 800, 170, 24); g.fill();
    g.fillStyle = "#7e22ce"; g.font = font(58, 800); g.fillText(`Rank #${rank.rank} / ${rank.total}`, 540, 935);
    g.font = font(30, 500); g.fillText(rank.percentile != null ? `Percentile ${rank.percentile}` : "Be the first to set the benchmark", 540, 985);
  }
  g.fillStyle = "#201a2b"; g.font = font(30, 500);
  g.fillText(`समय: ${fmtT(t.totalTime)} · औसत ${fmtT(t.avgTime)}/प्रश्न`, 540, 1100);
  g.fillStyle = "#6b6178"; g.font = font(26, 500);
  g.fillText((getDisplayName() || "Student") + " · " + new Date().toLocaleDateString("en-IN"), 540, 1160);
  g.fillStyle = "#201a2b"; g.font = font(30); g.fillText("rajgkguru.aldhruacademy.com", 540, 1280);
  return c;
}

/** Fills the results page's extra blocks and records the attempt once (stats, XP/badges, leaderboard, history). */
export async function renderResultsExtras(mount, ctx) {
  const { TEST, STATE, r, t, examSlug } = ctx;
  const topics = topicRowsFromTest(TEST, STATE);
  const isFixed = !!TEST.mockId;
  const answered = r.correct + r.wrong;
  const doneKey = `done:${TEST.test_id}`;
  let award = null, rank = null;

  if (!lsGet(doneKey)) {
    lsSet(doneKey, "1");
    addHistory(examSlug, { testId: TEST.test_id, title: TEST.title, mockId: TEST.mockId || null, kind: TEST.kind || "test", score: r.score,
                           maxScore: TEST.questions.length * (TEST.marks_per_question || 1), pct: pct(r.correct, TEST.questions.length),
                           correct: r.correct, wrong: r.wrong, total: TEST.questions.length, timeSec: t.totalTime });
    await recordStats(examSlug, TEST.questions, STATE.answers, STATE.questionTimes);
    const allStats = await loadStats(examSlug);
    award = await awardAfterTest({ examSlug, answered, correct: r.correct, wrong: r.wrong, total: TEST.questions.length, timeSec: t.totalTime, isFixed, topicStats: allStats });
    lsSet(`award:${TEST.test_id}`, JSON.stringify({ xp: award.xpGained, badges: award.newBadges.map((b) => b.id) }));
    if (isFixed) await submitScore(examSlug, TEST.mockId, { score: r.score, correct: r.correct, wrong: r.wrong, total: TEST.questions.length, timeSec: t.totalTime });
  } else {
    try { const a = JSON.parse(lsGet(`award:${TEST.test_id}`) || "null"); if (a) award = { xpGained: a.xp, newBadges: BADGES.filter((b) => a.badges.includes(b.id)), gam: getGam() }; } catch (e) {}
  }
  if (isFixed) rank = await getRank(examSlug, TEST.mockId, r.score);

  const gam = getGam();
  const lines = insightLines(TEST, STATE, r, topics);
  const tRows = topics.filter((x) => x.topic).sort((a, b) => pct(a.c, a.c + a.w) - pct(b.c, b.c + b.w))
    .map((x) => { const p = pct(x.c, x.c + x.w); return `<tr><td>${E(x.topic)}<div class="small">${E(x.subject)}</div></td><td class="c">${x.c}/${x.c + x.w + x.k}</td><td>${bar(p, accClass(p))}</td><td class="c">${x.c + x.w ? p + "%" : "—"}</td></tr>`; }).join("");
  const byOut = (fn) => TEST.questions.filter(fn);
  const avg = (qs) => (qs.length ? qs.reduce((s, q) => s + (STATE.questionTimes[q.id] || 0), 0) / qs.length : 0);
  const okQs = byOut((q) => STATE.answers[q.id] === q.correct_option), badQs = byOut((q) => STATE.answers[q.id] != null && STATE.answers[q.id] !== q.correct_option), skQs = byOut((q) => STATE.answers[q.id] == null);
  const subjTime = {};
  TEST.questions.forEach((q) => { const s = q.subject || "Other"; (subjTime[s] ??= []).push(STATE.questionTimes[q.id] || 0); });
  const subjTimeRows = Object.entries(subjTime).map(([s, a]) => ({ s, avg: a.reduce((x, y) => x + y, 0) / a.length })).sort((a, b) => b.avg - a.avg)
    .map((x) => `<div class="subject-bar-row"><span class="label">${E(x.s)}</span><div class="subject-bar-track"><div class="subject-bar-fill" style="width:${Math.min(100, (x.avg / Math.max(1, t.avgTime * 2.2)) * 100)}%"></div></div><span class="frac">${fmtT(x.avg)}</span></div>`).join("");
  const slow = [...TEST.questions.keys()].sort((a, b) => (STATE.questionTimes[TEST.questions[b].id] || 0) - (STATE.questionTimes[TEST.questions[a].id] || 0)).slice(0, 5)
    .map((i) => `<a class="chip-link" href="#rq-${i}">प्रश्न ${i + 1} · ${fmtT(STATE.questionTimes[TEST.questions[i].id] || 0)}</a>`).join("");
  const buckets = timeBuckets(TEST, STATE).map((b) => `<tr><td>${b.label}</td><td class="c">${b.n}</td><td>${bar(b.acc, accClass(b.acc))}</td><td class="c">${b.answered ? b.acc + "%" : "—"}</td></tr>`).join("");

  const rankBlock = isFixed ? (rank
    ? `<div class="fx-card fx-rank"><div class="fx-big">#${rank.rank}<span> / ${rank.total}</span></div><div>${rank.percentile != null ? `Percentile <b>${rank.percentile}</b>` : "अभी सबसे पहले प्रतिभागी!"} <span class="small">· इस मॉक को हल करने वाले छात्रों में (आपका सर्वश्रेष्ठ स्कोर)</span></div></div>`
    : `<div class="fx-card"><b>🏆 रैंक और पर्सेंटाइल जानने के लिए साइन इन करें</b> — इस मॉक को हल करने वाले सभी छात्रों से अपनी तुलना देखें। <button class="btn btn-primary btn-sm" id="fx-signin">साइन इन</button></div>`) : "";
  const awardBlock = award ? `<div class="fx-card fx-award"><b>+${award.xpGained} XP</b> · Level ${levelOf(gam.xp)} · 🔥 ${gam.streak} दिन की स्ट्रीक${award.newBadges.length ? `<div class="fx-badges">${award.newBadges.map((b) => `<span class="fx-badge new" title="${E(b.desc)}">${b.icon} ${E(b.name)}</span>`).join("")}</div>` : ""}</div>` : "";

  mount.innerHTML = `
    ${rankBlock}${awardBlock}
    ${lines.length ? `<div class="fx-card"><div class="fx-title">🔍 आपके लिए विश्लेषण (Insights)</div><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul></div>` : ""}
    ${tRows ? `<div class="fx-card"><div class="fx-title">📊 टॉपिक-वार ताकत/कमज़ोरी (इस टेस्ट में)</div><table class="fx-table"><tr><th>टॉपिक</th><th>सही</th><th></th><th>%</th></tr>${tRows}</table></div>` : ""}
    <div class="fx-card"><div class="fx-title">⏱ समय-प्रबंधन विश्लेषण</div>
      <div class="fx-stats"><div><b>${fmtT(avg(okQs))}</b><span>सही उत्तरों पर औसत</span></div><div><b>${fmtT(avg(badQs))}</b><span>गलत उत्तरों पर औसत</span></div><div><b>${fmtT(avg(skQs))}</b><span>छोड़े प्रश्नों पर औसत</span></div><div><b>${fmtT(t.avgTime)}</b><span>कुल औसत/प्रश्न</span></div></div>
      <table class="fx-table"><tr><th>समय/प्रश्न</th><th>प्रश्न</th><th>Accuracy</th><th></th></tr>${buckets}</table>
      <div class="fx-sub">विषय के अनुसार औसत समय</div>${subjTimeRows}
      <div class="fx-sub">सबसे ज़्यादा समय लेने वाले प्रश्न</div><div>${slow}</div></div>
    <div class="fx-card" id="fx-life"><div class="fx-title">🧭 आपकी अब तक की कमज़ोरियाँ और सुझाव</div><div class="small">लोड हो रहा है…</div></div>
    <div class="fx-actions">
      <button class="btn btn-secondary" id="fx-card-btn">🖼 स्कोरकार्ड डाउनलोड करें</button>
      ${TEST.pool === "paid" && TEST.mockId && PAID_PDF_URL ? `<button class="btn btn-secondary" id="fx-pdf-btn">📄 वॉटरमार्क PDF डाउनलोड करें</button>` : ""}
      <a class="btn btn-secondary" id="fx-share-btn" target="_blank" rel="noopener">📲 WhatsApp पर शेयर करें</a>
    </div>`;

  const shareText = `मैंने ${ctx.examTitle} — ${TEST.title} में ${r.score.toFixed(1)} अंक (${r.accuracy}% accuracy${rank ? `, रैंक #${rank.rank}` : ""}) पाए! आप भी आज़माएं: https://rajgkguru.aldhruacademy.com/${examSlug}/`;
  mount.querySelector("#fx-share-btn").href = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
  mount.querySelector("#fx-pdf-btn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = "PDF बन रहा है…";
    try {
      const user = getCurrentUser();
      const idToken = await user.getIdToken();
      const res = await fetch(`${PAID_PDF_URL}/generate_pdf`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` },
        body: JSON.stringify({ exam_slug: examSlug, exam_title: ctx.examTitle, title: TEST.title, qids: TEST.questions.map((q) => q.id), with_answers: true }),
      });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || `HTTP ${res.status}`); }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `${TEST.title.replace(/[^A-Za-z0-9]+/g, "-")}.pdf`; a.click();
    } catch (err) {
      alert("PDF नहीं बन सका: " + (err.message || "कृपया बाद में कोशिश करें।"));
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  });
  mount.querySelector("#fx-card-btn").onclick = async () => {
    const c = await drawScorecard(ctx, r, t, rank);
    const a = document.createElement("a"); a.download = `scorecard-${examSlug}.png`; a.href = c.toDataURL("image/png"); a.click();
  };
  mount.querySelector("#fx-signin")?.addEventListener("click", async () => { await showAuthModal({ reason: "रैंक देखने के लिए साइन इन करें।" }); location.reload(); });

  // lifetime strengths / weaknesses + recommendations
  const life = mount.querySelector("#fx-life");
  const stats = await loadStats(examSlug);
  const weak = weakTopics(stats, 4, 5);
  const recs = [];
  if (r.wrong) recs.push(`<a class="btn btn-primary btn-sm" href="index.html?practiceWrong=1">❌ गलत प्रश्नों का अभ्यास</a>`);
  if (weak.length) recs.push(`<a class="btn btn-primary btn-sm" href="index.html?smart=1">🎯 कमज़ोर टॉपिक स्मार्ट प्रैक्टिस</a>`);
  recs.push(`<a class="btn btn-secondary btn-sm" href="index.html#z-mocks">📝 अगला मॉक टेस्ट</a>`);
  life.innerHTML = `<div class="fx-title">🧭 आपकी अब तक की कमज़ोरियाँ और सुझाव</div>${weak.length
    ? `<table class="fx-table"><tr><th>सबसे कमज़ोर टॉपिक (सभी टेस्ट मिलाकर)</th><th>सही/हल</th><th></th></tr>${weak.map((x) => `<tr><td>${E(x.topic)}<div class="small">${E(x.subject)}</div></td><td class="c">${x.c}/${x.c + x.w}</td><td>${bar(Math.round(x.acc * 100), accClass(x.acc * 100))}</td></tr>`).join("")}</table>`
    : `<p class="small">कुछ और टेस्ट हल करने के बाद यहाँ आपके सबसे कमज़ोर टॉपिक दिखेंगे।</p>`}<div class="fx-actions">${recs.join("")}</div>`;
}

// ---------------------------------------------------------------- review enhancements: bookmark / note / discuss
export function enhanceReview(root, ctx) {
  const { TEST, examSlug } = ctx;
  root.querySelectorAll("[data-qi]").forEach((card) => {
    const i = Number(card.dataset.qi);
    const q = TEST.questions[i];
    const bar = document.createElement("div");
    bar.className = "fx-qactions";
    const bm = isBookmarked(examSlug, q.id);
    bar.innerHTML = `<button class="fx-qbtn" data-a="bm">${bm ? "★ बुकमार्क हटाएं" : "☆ बुकमार्क"}</button><button class="fx-qbtn" data-a="note">📝 नोट</button><button class="fx-qbtn" data-a="discuss">💬 चर्चा / Doubt</button><div class="fx-thread" hidden></div>`;
    card.appendChild(bar);
    bar.querySelector('[data-a="bm"]').onclick = async (e) => {
      const on = await toggleBookmark(examSlug, q);
      e.target.textContent = on ? "★ बुकमार्क हटाएं" : "☆ बुकमार्क";
    };
    bar.querySelector('[data-a="note"]').onclick = () => openNote(examSlug, q);
    bar.querySelector('[data-a="discuss"]').onclick = () => toggleThread(bar.querySelector(".fx-thread"), q);
  });
}

export function openNote(examSlug, q, after) {
  const cur = getBookmarksLocal()[`${examSlug}::${q.id}`]?.note || "";
  const m = modal(`<h3>📝 निजी नोट</h3><p class="small">यह नोट आपके बुकमार्क में सेव होगा (साइन-इन करने पर सभी डिवाइस पर)।</p><textarea class="fx-textarea" maxlength="1000" placeholder="इस प्रश्न के बारे में अपना नोट लिखें…">${E(cur)}</textarea><button class="btn btn-primary btn-block" id="fx-save-note">सेव करें</button>`);
  m.el.querySelector("#fx-save-note").onclick = async () => { await setNote(examSlug, q, m.el.querySelector("textarea").value); m.close(); after?.(); };
}

async function toggleThread(box, q) {
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="small">लोड हो रहा है…</div>`;
  const draw = async () => {
    const list = await loadComments(q);
    const me = getCurrentUser()?.uid;
    box.innerHTML = list === null
      ? `<div class="small">चर्चा अभी उपलब्ध नहीं है।</div>`
      : `${list.length ? list.map((c) => `<div class="fx-comment ${c.kind === "doubt" ? "doubt" : ""}"><b>${E(c.name || "Student")}</b>${c.kind === "doubt" ? ` <span class="pill">Doubt</span>` : ""}<div>${E(c.text)}</div>${c.uid === me ? `<button class="fx-del" data-id="${E(c.id)}">हटाएं</button>` : ""}</div>`).join("") : `<div class="small">अभी कोई चर्चा नहीं — पहला सवाल/जवाब आप लिखें।</div>`}
        <textarea class="fx-textarea" maxlength="500" placeholder="अपना जवाब या Doubt लिखें (500 अक्षर तक)…"></textarea>
        <div class="fx-actions"><button class="btn btn-primary btn-sm" data-k="comment">जवाब पोस्ट करें</button><button class="btn btn-secondary btn-sm" data-k="doubt">Doubt पूछें</button></div>
        <div class="small">कृपया सम्मानजनक भाषा रखें। गलत सामग्री हटाने का अधिकार हमारे पास सुरक्षित है।</div>`;
    box.querySelectorAll("[data-k]").forEach((b) => { b.onclick = async () => { const ok = await postComment(q, box.querySelector("textarea").value, b.dataset.k); if (ok) draw(); }; });
    box.querySelectorAll(".fx-del").forEach((b) => { b.onclick = async () => { if (await deleteComment(q, b.dataset.id)) draw(); }; });
  };
  draw();
}

// ============================================================================ EXAM HOME EXTRAS
const TOPIC_MIN = 5;

function poolTopics(questions) {
  const by = {};
  for (const q of questions) {
    if (!q.topic) continue;
    const s = (by[q.subject || "Other"] ??= {});
    s[q.topic] = (s[q.topic] || 0) + 1;
  }
  return by;
}

export async function mountHomeExtras(ctx) {
  const { root, examSlug, examTitle, free, hasPaidAccess, scheme, subjectsMeta, mocks, FT_COUNT, FT_MINUTES } = ctx;
  const top = root.querySelector("#extras-top"), mid = root.querySelector("#extras-mid");
  if (!top || !mid) return;
  await Promise.all([syncGam(), syncPlans()]);
  const gam = getGam();
  const stats = await loadStats(examSlug);
  const weak = weakTopics(stats, 4, 5);
  const plan = getPlan(examSlug);
  const bmCount = Object.keys(getBookmarksLocal()).filter((k) => k.startsWith(examSlug + "::")).length;

  // ---- tabs (F26)
  const tabs = [["z-practice", "अभ्यास"], ["z-mocks", "मॉक टेस्ट"], ["z-pyp", "पिछले पेपर"], ["z-sectional", "सेक्शनल"], ["z-topics", "टॉपिक क्विज़"], ["z-tools", "टूल्स"], ["z-board", "लीडरबोर्ड"]]
    .filter(([id]) => document.getElementById(id));
  const trust = `<div class="trust-strip"><span>✔ असली PYQ आधारित</span><span>✔ आधिकारिक उत्तर-कुंजी</span><span>✔ स्वतंत्र उत्तर-जाँच</span><span>✔ गलती की रिपोर्ट करें</span><a href="/about.html">हमारी गुणवत्ता प्रक्रिया →</a></div>`;

  // ---- "for you" card: streak/XP, planner progress, weak topics, smart practice (F31, F43, F49, F25)
  let planHtml = `<button class="btn btn-secondary btn-sm" id="fx-plan-btn">📅 स्टडी प्लानर बनाएं</button>`;
  if (plan) {
    const dl = daysLeft(plan.date), done = todayCount(examSlug), p = Math.min(100, pct(done, plan.daily));
    planHtml = `<div class="fx-plan"><b>आज का लक्ष्य:</b> ${done}/${plan.daily} प्रश्न ${bar(p, p >= 100 ? "good" : "mid")}<span class="small">परीक्षा में ${dl >= 0 ? dl + " दिन शेष" : "तारीख निकल चुकी"} · </span><button class="fx-link" id="fx-plan-btn">बदलें</button></div>`;
  }
  const weakHtml = weak.length
    ? `<div class="fx-weak"><b>🎯 कमज़ोर टॉपिक:</b> ${weak.slice(0, 3).map((x) => `<span class="chip bad">${E(x.topic)} · ${Math.round(x.acc * 100)}%</span>`).join(" ")} <button class="btn btn-primary btn-sm" id="fx-smart-btn">स्मार्ट प्रैक्टिस शुरू करें</button></div>`
    : `<div class="fx-weak small">कुछ टेस्ट देने के बाद यहाँ आपके कमज़ोर टॉपिक और उन पर स्मार्ट प्रैक्टिस दिखेगी।</div>`;
  const nudge = gam.last && gam.last !== new Date().toISOString().slice(0, 10) && gam.streak > 0
    ? `<div class="fx-nudge">🔥 आपकी ${gam.streak} दिन की स्ट्रीक आज टूट सकती है — एक छोटा क्विज़ हल करें!</div>` : "";
  const badgeStrip = BADGES.map((b) => `<span class="fx-badge ${gam.badges[b.id] ? "on" : ""}" title="${E(b.name)} — ${E(b.desc)}">${b.icon}</span>`).join("");
  top.innerHTML = `
    <nav class="exam-tabs">${tabs.map(([id, l]) => `<a href="#${id}">${l}</a>`).join("")}</nav>
    ${trust}
    <div class="zone fx-foryou">
      <div class="zone-title">⭐ आपके लिए</div>${nudge}
      <div class="fx-stats"><div><b>Lv ${levelOf(gam.xp)}</b><span>${gam.xp} XP</span></div><div><b>🔥 ${gam.streak}</b><span>दिन की स्ट्रीक</span></div><div><b>${gam.answered}</b><span>प्रश्न हल किए</span></div><div><b>${gam.tests}</b><span>टेस्ट पूरे</span></div></div>
      <div class="fx-badges">${badgeStrip}</div>${planHtml}${weakHtml}</div>`;

  // ---- sectional tests (F18, F23)
  const sections = (subjectsMeta?.sections || []).map((s) => s.name);
  const subjToSection = {};
  (subjectsMeta?.subjects || []).forEach((s) => { subjToSection[s.name] = s.section; });
  const freeBySection = {};
  free.questions.forEach((q) => { const sec = subjToSection[q.subject] || "अन्य विषय"; (freeBySection[sec] ??= { subjects: new Set(), n: 0 }); freeBySection[sec].subjects.add(q.subject); freeBySection[sec].n++; });
  const ratioBySection = {};
  Object.entries(free.subject_ratios || {}).forEach(([s, r]) => { const sec = subjToSection[s] || "अन्य विषय"; ratioBySection[sec] = (ratioBySection[sec] || 0) + r; });
  const totalRatio = Object.values(ratioBySection).reduce((a, b) => a + b, 0) || 1;
  const secCards = Object.entries(freeBySection).filter(([, d]) => d.n >= 10).map(([sec, d]) => {
    const share = (ratioBySection[sec] || 0) / totalRatio;
    const count = Math.max(10, Math.min(d.n, Math.round(FT_COUNT * share) || 15));
    const mins = Math.max(5, Math.round(FT_MINUTES * (count / FT_COUNT)));
    return `<div class="subject-card"><div class="subject-card-name-hi">${E(sec)}</div><div class="subject-card-count">${count} प्रश्न · ${mins} मिनट</div><button class="btn btn-primary btn-subject" data-sec="${E(sec)}" data-count="${count}" data-mins="${mins}">सेक्शनल टेस्ट</button></div>`;
  }).join("");

  // ---- topic quizzes (F19)
  const topicMap = poolTopics(free.questions);
  const subjOpts = Object.keys(topicMap).filter((s) => Object.values(topicMap[s]).some((n) => n >= TOPIC_MIN)).sort();

  mid.innerHTML = `
    ${secCards ? `<div class="zone" id="z-sectional"><div class="zone-title">🧩 सेक्शनल टेस्ट (Sectional Timer)</div><p class="zone-sub">एक सेक्शन के प्रश्न, परीक्षा के अनुपात में प्रश्न-संख्या और समय के साथ। समय पूरा होते ही टेस्ट अपने-आप सबमिट होगा।</p><div class="subject-grid">${secCards}</div></div>` : ""}
    ${subjOpts.length ? `<div class="zone" id="z-topics"><div class="zone-title">🎓 टॉपिक-वार क्विज़</div><p class="zone-sub">कोई भी विषय और टॉपिक चुनकर 10 प्रश्नों का त्वरित क्विज़ — हर उत्तर पर तुरंत स्पष्टीकरण।</p>
      <div class="fx-row"><select id="fx-subj" class="fx-select">${subjOpts.map((s) => `<option>${E(s)}</option>`).join("")}</select><select id="fx-topic" class="fx-select"></select><button class="btn btn-primary" id="fx-topic-go">क्विज़ शुरू करें</button></div></div>` : ""}
    <div class="zone" id="z-tools"><div class="zone-title">🧰 टूल्स</div>
      <div class="fx-tools">
        <button class="fx-tool" id="fx-search-btn"><span>🔎</span>प्रश्न खोजें</button>
        <button class="fx-tool" id="fx-flash-btn"><span>🃏</span>फ्लैशकार्ड</button>
        <a class="fx-tool" href="/bookmarks.html?exam=${E(examSlug)}"><span>🔖</span>बुकमार्क ${bmCount ? `(${bmCount})` : ""}</a>
        <a class="fx-tool" href="/notes/${E(examSlug)}.html"><span>📄</span>रिवीज़न नोट्स (PDF)</a>
        <button class="fx-tool" id="fx-remind-btn"><span>🔔</span>रिमाइंडर</button>
        <button class="fx-tool" id="fx-plan-btn2"><span>📅</span>स्टडी प्लानर</button>
        <a class="fx-tool" href="/dashboard.html"><span>📈</span>मेरी प्रगति</a>
      </div></div>
    <div class="zone" id="z-board"><div class="zone-title">🏆 लीडरबोर्ड</div><p class="zone-sub">फ़िक्स्ड मॉक/पेपर पर छात्रों का सर्वश्रेष्ठ स्कोर।</p>
      <div class="fx-row"><select id="fx-board-sel" class="fx-select">${[...(mocks?.free || []).map((m) => [m.id, m.title]), ...(mocks?.paid || []).slice(0, 8).map((m) => [m.id, m.title])].map(([id, t]) => `<option value="${E(id)}">${E(t)}</option>`).join("")}</select></div>
      <div id="fx-board-out" class="small">लोड हो रहा है…</div></div>`;

  // the tab bar was drawn before the sections below existed -- rebuild it now that every anchor is in the page
  const allTabs = [["z-practice", "अभ्यास"], ["z-mocks", "मॉक टेस्ट"], ["z-pyp", "पिछले पेपर"], ["z-sectional", "सेक्शनल"], ["z-topics", "टॉपिक क्विज़"], ["z-tools", "टूल्स"], ["z-board", "लीडरबोर्ड"]]
    .filter(([id]) => document.getElementById(id));
  top.querySelector(".exam-tabs").innerHTML = allTabs.map(([id, l]) => `<a href="#${id}">${l}</a>`).join("");

  // ---- wiring: planner
  const openPlanner = () => {
    const nearest = ctx.nextExamDate || "";
    const m = modal(`<h3>📅 स्टडी प्लानर</h3><p class="small">परीक्षा की तारीख और रोज़ के प्रश्नों का लक्ष्य तय करें — हम आपकी रोज़ की प्रगति ट्रैक करेंगे।</p>
      <label class="small">परीक्षा की तारीख</label><input type="date" class="fx-select" id="fx-pdate" value="${E(plan?.date || nearest)}">
      <label class="small">रोज़ का लक्ष्य (प्रश्न)</label><input type="number" min="5" max="500" class="fx-select" id="fx-pdaily" value="${plan?.daily || 40}">
      <p class="small" id="fx-psuggest"></p><button class="btn btn-primary btn-block" id="fx-psave">सेव करें</button>`);
    const upd = () => { const d = m.el.querySelector("#fx-pdate").value; if (d) { const left = Math.max(1, daysLeft(d)); const remaining = Math.max(0, free.questions.length - (getGam().answered || 0)); m.el.querySelector("#fx-psuggest").textContent = `${left} दिन बचे हैं। इस पूल के बचे प्रश्न पूरे करने के लिए लगभग ${Math.ceil(remaining / left)} प्रश्न/दिन।`; } };
    m.el.querySelector("#fx-pdate").onchange = upd; upd();
    m.el.querySelector("#fx-psave").onclick = async () => { const date = m.el.querySelector("#fx-pdate").value; if (!date) return alert("परीक्षा की तारीख चुनें।"); await setPlan(examSlug, { date, daily: Math.max(5, Number(m.el.querySelector("#fx-pdaily").value) || 40) }); m.close(); location.reload(); };
  };
  document.getElementById("fx-plan-btn")?.addEventListener("click", openPlanner);
  document.getElementById("fx-plan-btn2")?.addEventListener("click", openPlanner);

  // ---- smart practice (F43): 60% from weak topics, rest from unseen questions
  document.getElementById("fx-smart-btn")?.addEventListener("click", () => startSmart(ctx, weak));
  if (new URLSearchParams(location.search).get("smart") === "1" && weak.length) startSmart(ctx, weak);

  // ---- sectional
  mid.querySelectorAll("[data-sec]").forEach((b) => {
    b.onclick = () => {
      const sec = b.dataset.sec;
      ctx.startTest({ poolName: "free", subjects: [...freeBySection[sec].subjects], count: Number(b.dataset.count), timeMinutes: Number(b.dataset.mins), instant: false, titlePrefix: `${sec} — सेक्शनल टेस्ट` });
    };
  });

  // ---- topic quiz
  const subjSel = document.getElementById("fx-subj"), topicSel = document.getElementById("fx-topic");
  if (subjSel) {
    const fillTopics = () => { topicSel.innerHTML = Object.entries(topicMap[subjSel.value] || {}).filter(([, n]) => n >= TOPIC_MIN).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<option value="${E(t)}">${E(t)} (${n})</option>`).join(""); };
    subjSel.onchange = fillTopics; fillTopics();
    document.getElementById("fx-topic-go").onclick = async () => {
      const pool = free.questions.filter((q) => q.subject === subjSel.value && q.topic === topicSel.value);
      const qs = ctx.pickUnseen(pool, Math.min(10, pool.length));
      ctx.startQuestions({ title: `${topicSel.value} — टॉपिक क्विज़`, questions: qs, timeMinutes: null, instant: true, pool: "free", kind: "topic" });
    };
  }

  // ---- tools
  document.getElementById("fx-search-btn").onclick = () => openSearch(ctx);
  document.getElementById("fx-flash-btn").onclick = () => openFlashcards(ctx);
  document.getElementById("fx-remind-btn").onclick = () => openReminders(ctx);

  // ---- leaderboard
  const boardSel = document.getElementById("fx-board-sel");
  const drawBoard = async () => {
    const out = document.getElementById("fx-board-out");
    if (!boardSel.value) { out.textContent = "अभी कोई मॉक उपलब्ध नहीं।"; return; }
    out.textContent = "लोड हो रहा है…";
    const rows = await topScores(examSlug, boardSel.value, 10);
    out.innerHTML = rows.length
      ? `<table class="fx-table"><tr><th>#</th><th>नाम</th><th>अंक</th><th>सही/गलत</th></tr>${rows.map((x, i) => `<tr><td class="c">${i + 1}</td><td>${E(x.name || "Student")}</td><td class="c"><b>${x.score}</b></td><td class="c">${x.correct}/${x.wrong}</td></tr>`).join("")}</table><p class="small">स्कोर छात्रों के ब्राउज़र से दर्ज होते हैं — यह अभ्यास लीडरबोर्ड है। नाम बदलने के लिए: <button class="fx-link" id="fx-rename">नाम बदलें</button></p>`
      : `<p>इस मॉक पर अभी कोई स्कोर नहीं — पहले बनें! (मॉक देकर साइन-इन रहें)</p>`;
    document.getElementById("fx-rename")?.addEventListener("click", () => { const n = prompt("लीडरबोर्ड पर कौन-सा नाम दिखाएं?", getDisplayName()); if (n !== null) setDisplayName(n); });
  };
  boardSel?.addEventListener("change", drawBoard);
  drawBoard();

  // ---- fixed-mock attempt history on the mock buttons (F24)
  root.querySelectorAll("[data-mock]").forEach((b) => {
    const [tier, idx] = b.dataset.mock.split(":");
    const m = mocks?.[tier]?.[Number(idx)];
    const s = m && mockSummary(examSlug, m.id);
    if (s) b.insertAdjacentHTML("beforeend", `<div class="mock-hist">सर्वश्रेष्ठ ${s.bestPct}% · ${s.attempts}× हल</div>`);
  });
}

function startSmart(ctx, weak) {
  const want = 20, fromWeak = Math.round(want * 0.6);
  const weakKeys = new Set(weak.map((x) => `${x.subject}||${x.topic}`));
  const inWeak = ctx.free.questions.filter((q) => weakKeys.has(`${q.subject}||${q.topic}`));
  const rest = ctx.free.questions.filter((q) => !weakKeys.has(`${q.subject}||${q.topic}`));
  const a = ctx.pickUnseen(inWeak, Math.min(fromWeak, inWeak.length));
  const taken = new Set(a.map((q) => q.id));
  const b = ctx.pickUnseen(rest.filter((q) => !taken.has(q.id)), want - a.length);
  ctx.startQuestions({ title: "स्मार्ट प्रैक्टिस — कमज़ोर टॉपिक पर फोकस", questions: [...a, ...b], timeMinutes: null, instant: true, pool: "free", kind: "smart" });
}

// ---------------------------------------------------------------- search (F58)
async function openSearch(ctx) {
  const m = modal(`<h3>🔎 प्रश्न खोजें</h3><p class="small">${ctx.hasPaidAccess ? "फ्री + पेड पूल में" : "फ्री पूल में"} खोजें (हिंदी/English शब्द)।</p><input class="fx-select" id="fx-q" placeholder="जैसे: हल्दीघाटी, मीणा, बांध…" autofocus><div id="fx-results" class="fx-results"></div>`);
  let pool = ctx.free.questions;
  if (ctx.hasPaidAccess) { try { pool = pool.concat((await ctx.fetchPaidPool(ctx.examSlug)).questions); } catch (e) {} }
  const norm = (s) => String(s || "").toLowerCase();
  const inp = m.el.querySelector("#fx-q"), out = m.el.querySelector("#fx-results");
  let timer;
  inp.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const term = norm(inp.value).trim();
      if (term.length < 2) { out.innerHTML = ""; return; }
      const hits = [];
      for (const q of pool) {
        const l = q.hindi || q.english || {};
        if (norm(l.question).includes(term) || (l.options || []).some((o) => norm(o).includes(term)) || norm(q.topic).includes(term)) hits.push(q);
        if (hits.length >= 25) break;
      }
      out.innerHTML = hits.length ? hits.map((q, i) => {
        const l = q.hindi || q.english;
        return `<div class="fx-hit"><div>${E(clipMath(l.question, 260))}</div><div class="small">✔ ${E(l.options[q.correct_option - 1] || "")}${l.explanation ? ` — ${E(clipMath(l.explanation, 160))}…` : ""}</div><button class="fx-qbtn" data-i="${i}">${isBookmarked(ctx.examSlug, q.id) ? "★ बुकमार्क हटाएं" : "☆ बुकमार्क"}</button></div>`;
      }).join("") : `<p class="small">कुछ नहीं मिला।</p>`;
      out.querySelectorAll("[data-i]").forEach((b) => { b.onclick = async () => { const on = await toggleBookmark(ctx.examSlug, hits[Number(b.dataset.i)]); b.textContent = on ? "★ बुकमार्क हटाएं" : "☆ बुकमार्क"; }; });
    }, 200);
  };
}

// ---------------------------------------------------------------- flashcards with simple spaced repetition (F38)
function openFlashcards(ctx) {
  const key = `flash:${ctx.examSlug}`;
  let box = {};
  try { box = JSON.parse(lsGet(key) || "{}"); } catch (e) {}
  const subjects = [...new Set(ctx.free.questions.map((q) => q.subject))].sort();
  const bm = Object.values(getBookmarksLocal()).filter((b) => b.slug === ctx.examSlug);
  const m = modal(`<h3>🃏 फ्लैशकार्ड</h3><div class="fx-row"><select class="fx-select" id="fx-fsub"><option value="__due">आज दोहराने वाले</option>${bm.length ? `<option value="__bm">बुकमार्क किए (${bm.length})</option>` : ""}${subjects.map((s) => `<option>${E(s)}</option>`).join("")}</select><button class="btn btn-primary btn-sm" id="fx-fgo">शुरू</button></div><div id="fx-fcard"></div>`);
  const day = () => Math.floor(Date.now() / 86400000);
  const LEITNER = [0, 1, 3, 7, 16];
  const deckFor = (v) => {
    if (v === "__bm") return bm.map((b) => ({ ...b.snap, id: b.qid }));
    let qs = ctx.free.questions;
    if (v === "__due") return qs.filter((q) => box[q.id] && box[q.id].due <= day()).slice(0, 30);
    qs = qs.filter((q) => q.subject === v);
    return qs.filter((q) => !box[q.id] || box[q.id].due <= day()).slice(0, 30);
  };
  const go = () => {
    const deck = deckFor(m.el.querySelector("#fx-fsub").value);
    const host = m.el.querySelector("#fx-fcard");
    if (!deck.length) { host.innerHTML = `<p class="small">अभी दोहराने के लिए कोई कार्ड नहीं — कोई विषय चुनें।</p>`; return; }
    let i = 0;
    const show = () => {
      if (i >= deck.length) { host.innerHTML = `<p><b>🎉 डेक पूरा!</b> ${deck.length} कार्ड देखे।</p>`; return; }
      const q = deck[i], l = q.hindi || q.english;
      host.innerHTML = `<div class="fx-flash" id="fx-flip"><div class="small">${i + 1}/${deck.length} · ${E(q.topic || q.subject || "")} · पलटने के लिए टैप करें</div><div class="fx-flash-front">${E(l.question)}</div><div class="fx-flash-back" hidden><b>✔ ${E(l.options[q.correct_option - 1])}</b>${l.explanation ? `<div class="small">${E(l.explanation)}</div>` : ""}</div></div>
        <div class="fx-actions" id="fx-frate" hidden><button class="btn btn-secondary btn-sm" data-r="0">फिर दिखाएं</button><button class="btn btn-primary btn-sm" data-r="1">आता है ✔</button></div>`;
      host.querySelector("#fx-flip").onclick = () => { host.querySelector(".fx-flash-back").hidden = false; host.querySelector("#fx-frate").hidden = false; };
      host.querySelectorAll("[data-r]").forEach((b) => { b.onclick = () => {
        const cur = box[q.id] || { lvl: 0 };
        const lvl = b.dataset.r === "1" ? Math.min(LEITNER.length - 1, cur.lvl + 1) : 0;
        box[q.id] = { lvl, due: day() + LEITNER[lvl] };
        lsSet(key, JSON.stringify(box)); i++; show();
      }; });
    };
    show();
  };
  m.el.querySelector("#fx-fgo").onclick = go;
}

// ---------------------------------------------------------------- reminders (F21)
function openReminders(ctx) {
  const cfg = (() => { try { return JSON.parse(lsGet("remind:v1") || "{}"); } catch (e) { return {}; } })();
  const m = modal(`<h3>🔔 रिमाइंडर</h3><p class="small">रोज़ की पढ़ाई के लिए याद दिलाने के दो तरीके:</p>
    <div class="fx-card"><b>1) कैलेंडर में जोड़ें (सबसे भरोसेमंद)</b><p class="small">Google/Apple/Outlook कैलेंडर में रोज़ का अभ्यास-रिमाइंडर${ctx.nextExamDate ? " और परीक्षा की तारीख" : ""} जुड़ जाएगा — फोन बंद/ऐप बंद होने पर भी बजेगा।</p>
      <div class="fx-row"><input type="time" class="fx-select" id="fx-rtime" value="${E(cfg.time || "07:00")}"><button class="btn btn-primary btn-sm" id="fx-ics">.ics डाउनलोड करें</button></div></div>
    <div class="fx-card"><b>2) इस ब्राउज़र में नोटिफ़िकेशन</b><p class="small">साइट खुली होने पर (किसी टैब में) तय समय पर याद दिलाएगा। पूरी तरह बंद होने पर नोटिफ़िकेशन के लिए हमारा सर्वर-पुश अभी शुरू नहीं हुआ है।</p>
      <button class="btn btn-secondary btn-sm" id="fx-notif">${cfg.notif ? "बंद करें" : "चालू करें"}</button></div>`);
  m.el.querySelector("#fx-ics").onclick = () => {
    const time = m.el.querySelector("#fx-rtime").value || "07:00";
    const [hh, mm] = time.split(":");
    const d = new Date(); d.setDate(d.getDate() + 1);
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//RAJ GK GURU//EN",
      "BEGIN:VEVENT", `UID:daily-${ctx.examSlug}@rajgkguru`, `DTSTAMP:${ymd}T000000Z`, `DTSTART:${ymd}T${hh}${mm}00`, "DURATION:PT45M", "RRULE:FREQ=DAILY;COUNT=120",
      `SUMMARY:RAJ G.K. GURU — ${ctx.examTitle} अभ्यास`, `DESCRIPTION:आज का टेस्ट/क्विज़ हल करें: https://rajgkguru.aldhruacademy.com/${ctx.examSlug}/`, "END:VEVENT"];
    if (ctx.nextExamDate) { const e = ctx.nextExamDate.replace(/-/g, ""); lines.push("BEGIN:VEVENT", `UID:exam-${ctx.examSlug}@rajgkguru`, `DTSTAMP:${ymd}T000000Z`, `DTSTART;VALUE=DATE:${e}`, `SUMMARY:${ctx.examTitle} — परीक्षा`, "END:VEVENT"); }
    lines.push("END:VCALENDAR");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join(String.fromCharCode(13, 10))], { type: "text/calendar" }));
    a.download = `rajgkguru-${ctx.examSlug}.ics`; a.click();
    lsSet("remind:v1", JSON.stringify({ ...cfg, time }));
  };
  m.el.querySelector("#fx-notif").onclick = async () => {
    if (cfg.notif) { lsSet("remind:v1", JSON.stringify({ ...cfg, notif: false })); m.close(); return; }
    if (!("Notification" in window)) return alert("आपका ब्राउज़र नोटिफ़िकेशन सपोर्ट नहीं करता।");
    const p = await Notification.requestPermission();
    if (p !== "granted") return alert("नोटिफ़िकेशन की अनुमति नहीं मिली।");
    lsSet("remind:v1", JSON.stringify({ ...cfg, notif: true, time: m.el.querySelector("#fx-rtime").value || "07:00", slug: ctx.examSlug, title: ctx.examTitle }));
    m.close();
  };
}

/** Called on every page load: fires the daily in-browser reminder once per day when the site is open at/after the chosen time. */
export function checkReminderTick() {
  try {
    const cfg = JSON.parse(lsGet("remind:v1") || "{}");
    if (!cfg.notif || !("Notification" in window) || Notification.permission !== "granted") return;
    const tick = () => {
      const now = new Date(), [h, mi] = (cfg.time || "07:00").split(":").map(Number);
      const key = `remind:fired:${now.toDateString()}`;
      if (lsGet(key) || now.getHours() * 60 + now.getMinutes() < h * 60 + mi) return;
      lsSet(key, "1");
      new Notification("RAJ G.K. GURU", { body: `आज का अभ्यास करें — ${cfg.title || "टेस्ट सीरीज़"}`, icon: "/shared/icon-192.png" });
    };
    tick(); setInterval(tick, 60000);
  } catch (e) {}
}
