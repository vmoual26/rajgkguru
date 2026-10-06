// Tabbed "study hub" layout for every exam page (2026-10-06 redesign).
// The exam page used to be one very long scroll of zones. Once the page has rendered, this regroups those SAME DOM nodes
// (so every button/handler keeps working) into five tabs -- Today / Practice / Mocks / Papers / Tools -- with a sticky pill bar
// (a bottom tab bar on phones), and for a paying student adds a member header: greeting, plan validity, exam countdown, streak.
// Visitors get the same tabs (default: Practice, so they can start immediately); members default to Today.

const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTHS = ["जन", "फ़र", "मार्च", "अप्रै", "मई", "जून", "जुला", "अग", "सित", "अक्टू", "नव", "दिस"];
const fmt = (d) => { const x = new Date(d + "T00:00:00"); return `${x.getDate()} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`; };
const daysTo = (d) => { const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((new Date(d + "T00:00:00") - t) / 86400000); };

const TABS = [
  ["today", "🏠", "आज"],
  ["practice", "📝", "अभ्यास"],
  ["mocks", "🧪", "मॉक टेस्ट"],
  ["papers", "📄", "पिछले पेपर"],
  ["tools", "🧰", "टूल्स"],
];

export async function applyHub(ctx) {
  const { root, examSlug, examTitle, hasPaidAccess, nextExamDate, gam, plan } = ctx;
  if (!root || root.querySelector(".hub-tabs")) return;

  // ---- who is this? (greeting + plan validity) -- only needed for members
  let prof = null;
  if (hasPaidAccess) {
    try {
      const m = await import("./entitlements.js?v=11");
      prof = await m.getMemberProfile();
      prof.mine = prof.purchases.find((p) => p.slug === examSlug) || prof.purchases.find((p) => p.slug === m.ALL_ACCESS) || null;
    } catch (e) { prof = null; }
  }

  // ---- header: replaces the plain title bar
  const oldHead = root.querySelector(".exam-page-header");
  const pills = [];
  if (hasPaidAccess) pills.push(`<span class="hub-pill pro">⭐ Pro${prof?.mine?.expires ? " · " + fmt(prof.mine.expires) + " तक" : ""}</span>`);
  else pills.push(`<span class="hub-pill">🆓 मुफ़्त अभ्यास</span>`);
  const examDate = plan?.date || nextExamDate;
  if (examDate && daysTo(examDate) >= 0) pills.push(`<span class="hub-pill">📅 परीक्षा में ${daysTo(examDate)} दिन</span>`);
  if (gam?.streak) pills.push(`<span class="hub-pill">🔥 ${gam.streak} दिन स्ट्रीक</span>`);
  if (gam?.xp) pills.push(`<span class="hub-pill">⚡ ${gam.xp} XP</span>`);
  const first = prof?.name ? prof.name.split(" ")[0] : "";
  const head = document.createElement("div");
  head.className = "hub-head";
  head.innerHTML = `${hasPaidAccess ? `<div class="hi">👋 नमस्ते${first ? ", " + E(first) : ""} — आपका स्टडी हब</div>` : ""}
    <h1>${E(examTitle)}</h1><div class="hub-pills">${pills.join("")}</div>`;
  if (oldHead) oldHead.replaceWith(head); else root.prepend(head);

  // ---- grab the zones (the nodes themselves move, so their event handlers survive)
  const q = (sel) => root.querySelector(sel);
  const scheme = q(".exam-scheme-box"), resume = q(".resume-banner"), premiumBanner = q(".premium-banner");
  const extrasTop = q("#extras-top"), forYou = extrasTop?.querySelector(".fx-foryou"), trust = extrasTop?.querySelector(".trust-strip");
  extrasTop?.querySelector(".exam-tabs")?.remove();            // the old anchor-link tab row; replaced by the hub tabs
  const zonePaid = q(".zone-paid"), zonePremium = q(".zone-premium");

  const panels = {};
  const wrap = document.createElement("div");
  wrap.className = "hub-panels";
  TABS.forEach(([id]) => { const p = document.createElement("section"); p.className = "hub-panel"; p.dataset.tab = id; panels[id] = p; wrap.appendChild(p); });
  const put = (id, node) => { if (node) panels[id].appendChild(node); };

  put("today", resume);
  put("today", premiumBanner);
  put("today", zonePaid);                                        // members: Full Test / Custom Test cards come FIRST
  put("today", forYou);
  put("today", zonePremium);                                     // visitors: the Premium pitch
  put("today", scheme);
  put("today", trust);
  put("practice", q("#z-practice"));
  put("practice", q("#z-sectional"));
  put("practice", q("#z-topics"));
  put("mocks", q("#z-mocks"));
  put("papers", q("#z-pyp"));
  put("tools", q("#z-tools"));
  put("tools", q("#z-board"));

  // empty tabs (e.g. an exam with no previous-year papers) are dropped
  const live = TABS.filter(([id]) => panels[id].childElementCount > 0);
  const bar = document.createElement("nav");
  bar.className = "hub-tabs";
  bar.setAttribute("role", "tablist");
  bar.innerHTML = live.map(([id, ico, label]) => `<button class="hub-tab" role="tab" data-tab="${id}"><span class="ti" aria-hidden="true">${ico}</span><span>${label}</span></button>`).join("");
  head.after(bar);
  bar.after(wrap);
  document.body.classList.add("has-hub");

  // the old zones' own heading margins read oddly inside a panel
  wrap.querySelectorAll(".zone").forEach((z) => z.classList.add("in-hub"));

  const show = (id, push = true) => {
    if (!panels[id] || !panels[id].childElementCount) id = live[0][0];
    live.forEach(([t]) => {
      panels[t].classList.toggle("active", t === id);
      bar.querySelector(`[data-tab="${t}"]`).classList.toggle("active", t === id);
    });
    if (push) { try { history.replaceState(null, "", "#" + id); } catch (e) {} }
    if (push) window.scrollTo({ top: Math.max(0, head.getBoundingClientRect().top + window.scrollY - 70), behavior: "smooth" });
    bar.querySelector(".hub-tab.active")?.scrollIntoView({ block: "nearest", inline: "center" });
  };
  bar.addEventListener("click", (ev) => { const b = ev.target.closest(".hub-tab"); if (b) show(b.dataset.tab); });

  // landing tab: explicit #hash (also the old #z-xxx anchors) > members: Today > visitors: Practice
  const h = location.hash.replace("#", "");
  const anchorMap = { "z-practice": "practice", "z-sectional": "practice", "z-topics": "practice", "z-mocks": "mocks", "z-pyp": "papers", "z-tools": "tools", "z-board": "tools" };
  show(panels[h] ? h : (anchorMap[h] || (hasPaidAccess ? "today" : "practice")), false);

  // other tools link here ("Start smart practice" etc.): jump to the tab that holds a requested element
  window.addEventListener("hashchange", () => { const k = location.hash.replace("#", ""); if (panels[k]) show(k, false); else if (anchorMap[k]) show(anchorMap[k], false); });

  // sticky offset = the actual (variable-height) site header
  const setH = () => document.documentElement.style.setProperty("--header-h", (document.getElementById("site-header")?.offsetHeight || 96) + "px");
  setH(); window.addEventListener("resize", setH);
}
