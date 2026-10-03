// Typesets maths inside question content, site-wide (started from chrome.js, so every page gets it).
//  - LaTeX written between $...$ (the question bank stores formulas that way) is rendered with KaTeX (MIT licence),
//    self-hosted in /shared/katex/ so it also works offline once seen (the service worker caches it).
//  - Plain-text leftovers are fixed too: x^2 / 10^-9 / 125^(log25 5) -> real superscripts, "× 10-19" -> 10⁻¹⁹,
//    "सेमी 3" / "से.मी.2" -> सेमी³ / से.मी.², and the printed question number that some stems carry ("69. ...")
//    is dropped because the player already shows "प्रश्न N.".
//  - Repairs data damage: a few explanations lost the backslash of \frac / \text / \times to a control character.
//  - TAB-separated match-the-column stems become a real table.
//  - It watches the DOM, so question text rendered later by any page script (player, review, flashcards, search,
//    bookmarks, question of the day) is handled without touching those scripts.
// Only elements matching SEL are touched; question text is never translated or altered beyond the fixes above.

const SEL = ".question-text,.q-line,.option,.explanation-box,.match-table,.daily-q,.daily-opt,.daily-fact,.bm-q,.fx-hit,.fx-flash";
const SKIP = ".katex,.mf-tex,[data-nomath],textarea,input,script,style";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BS = String.fromCharCode(92);   // a backslash

// $...$ : the opening $ must be followed by a non-space and the closing $ preceded by one and not followed by a digit
// (so "US $ 6681" or "$5 and $6" are left alone, as TeX/pandoc do).
const MATH_RE = /(?<![\\$])\$(?!\s)((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?!\d)/g;
const looksLikeMath = (c) => c.trim() && !/[@#]/.test(c) && !/(^|[^\\])%/.test(c);

// ---------------------------------------------------------------- plain-text fixes
const SUP = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻", "−": "⁻", "+": "⁺" };
const POWER_RE = /\^(\{[^{}]{1,14}\}|\([^()]{1,18}\)|[-−+]?[A-Za-z0-9.]{1,6})/g;
const TIMES10_RE = /(×\s*10)\s?([-−]\d{1,3})(?!\d)/g;
const U_L = "(?<![\\u0900-\\u097F])";                                        // not in the middle of a Hindi word
const UNIT_POWER_RE = new RegExp(
  U_L + "((?:से\\.?\\s?मी\\.?|सेमी\\.?|कि\\.?\\s?मी\\.?|किमी|(?<![A-Za-z])(?:cm|mm|km|dm))|मी\\.)(?:([23])(?![\\d])|\\s([23])(?![\\d.]|\\s*(?:सेमी|से\\.?\\s?मी|मी(?![\\u0900-\\u097F])|कि\\.?\\s?मी|किमी|cm|mm|km|m\\b|मीटर|ग्राम|किग्रा)))", "g");

function plainFix(text) {
  if (!/[\^×]|\s?[23]/.test(text)) return null;
  let changed = false;
  let out = esc(text);
  out = out.replace(TIMES10_RE, (m, a, b) => { changed = true; return `${a}<sup>${b.replace("-", "−")}</sup>`; });
  out = out.replace(POWER_RE, (m, p) => { changed = true; return `<sup>${p.replace(/^[{(]|[})]$/g, "").replace(/-/g, "−")}</sup>`; });
  out = out.replace(UNIT_POWER_RE, (m, unit, d1, d2) => { changed = true; return unit + SUP[d1 || d2]; });
  return changed ? out : null;
}

// ---------------------------------------------------------------- LaTeX
// KaTeX has no Devanagari glyphs in maths mode: wrap Hindi runs in \text{...} so they render as normal text.
function prepTex(src) {
  return src.split(/(\\text\{[^{}]*\})/).map((seg, i) => (i % 2 ? seg
    : seg.replace(/[ऀ-ॿ]+(?:[  .]*[ऀ-ॿ.]+)*/g, (m) => `\\text{${m}}`))).join("");
}

// Readable plain-text version for when KaTeX can't render a formula (offline on first view, or unsupported command).
function texToPlain(src) {
  let s = src;
  const grp = "\\{([^{}]*)\\}";
  for (let i = 0; i < 4; i++) {
    s = s.replace(new RegExp("\\\\[dt]?frac" + grp + grp, "g"), "($1)/($2)")
      .replace(new RegExp("\\\\sqrt" + grp, "g"), "√($1)")
      .replace(new RegExp("\\\\(?:text|mathrm|mathbf|operatorname)" + grp, "g"), "$1")
      .replace(new RegExp("\\\\(?:overline|bar|vec|hat|underline|dot)" + grp, "g"), "$1");
  }
  const map = { times: "×", div: "÷", cdot: "·", pi: "π", theta: "θ", alpha: "α", beta: "β", gamma: "γ", lambda: "λ", omega: "ω", Omega: "Ω",
    Delta: "Δ", circ: "°", angle: "∠", pm: "±", ne: "≠", neq: "≠", le: "≤", ge: "≥", approx: "≈", infty: "∞", rightarrow: "→",
    Rightarrow: "⇒", implies: "⇒", partial: "∂", int: "∫", prime: "′", propto: "∝", sin: "sin", cos: "cos", tan: "tan", cot: "cot",
    sec: "sec", csc: "csc", log: "log", min: "min", lfloor: "⌊", rfloor: "⌋", mu: "μ", rho: "ρ", phi: "φ", epsilon: "ε" };
  s = s.replace(/\\([A-Za-z]+)/g, (m, c) => (c in map ? map[c] : ""));
  s = s.replace(/\\([%&_{}#$])/g, "$1").replace(/\\[,;:! ]/g, " ").replace(/~/g, " ");
  s = s.replace(/\^\{([^{}]*)\}/g, (m, p) => p.split("").map((ch) => SUP[ch] || ch).join(""))
    .replace(/\^([0-9+\-])/g, (m, p) => SUP[p] || p).replace(/_\{([^{}]*)\}/g, "$1").replace(/_([A-Za-z0-9])/g, "$1");
  return s.replace(/[{}]/g, "");
}

let katexP = null;
function loadKatex() {
  if (katexP) return katexP;
  katexP = new Promise((resolve) => {
    if (window.katex) return resolve(window.katex);
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/shared/katex/katex.min.css"; document.head.appendChild(l);
    const s = document.createElement("script"); s.src = "/shared/katex/katex.min.js";
    s.onload = () => resolve(window.katex || null); s.onerror = () => resolve(null);
    document.head.appendChild(s);
    setTimeout(() => resolve(window.katex || null), 6000);   // never leave a formula hidden if the network hangs
  });
  return katexP;
}

async function typeset(spans) {
  const k = await loadKatex();
  for (const el of spans) {
    const tex = el.dataset.tex;
    let html = null;
    if (k) {
      try { html = k.renderToString(prepTex(tex), { throwOnError: true, strict: "ignore", trust: false }); } catch (e) { html = null; }
    }
    if (html) el.innerHTML = html; else el.textContent = texToPlain(tex);
    el.classList.add("mf-done");
  }
}

// ---------------------------------------------------------------- data repair
// A few explanations were stored with the backslash of a LaTeX command turned into a control character
// (form feed in \frac, TAB in \text / \times, backspace in \begin, CR -- read by the browser as a newline -- in
// \rightarrow). Put the backslash back. A TAB that is a genuine column separator is left alone.
const FF = String.fromCharCode(12), BSP = String.fromCharCode(8), TAB = String.fromCharCode(9);
const FIX_FF = new RegExp(FF, "g");
const FIX_BSP = new RegExp(BSP, "g");
const FIX_TAB = new RegExp(TAB + "(?=ext|imes|heta|riangle|ilde|extbf|extit)", "g");
const FIX_CR = /[\r\n](?=ightarrow|ightleftharpoons|ightharpoon)/g;
function repair(s) {
  return s.replace(FIX_FF, BS + "f").replace(FIX_BSP, BS + "b").replace(FIX_TAB, BS + "t").replace(FIX_CR, BS + "r");
}

// A stem laid out with TAB-separated columns ("समूह-A<TAB>समूह-B") becomes a real table, like the " | " layout does.
function tabTables(qt) {
  const lines = [...qt.children].filter((c) => c.classList && c.classList.contains("q-line"));
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].textContent.includes(TAB)) { i++; continue; }
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].textContent.includes(TAB) && lines[j + 1] === lines[j].nextElementSibling) j++;
    const table = document.createElement("table");
    table.className = "match-table";
    for (let k = i; k <= j; k++) {
      const tr = table.insertRow();
      lines[k].textContent.split(TAB).filter((c) => c.trim()).forEach((c) => { tr.insertCell().textContent = c.trim(); });
    }
    lines[i].before(table);
    for (let k = i; k <= j; k++) lines[k].remove();
    i = j + 1;
  }
}

// ---------------------------------------------------------------- DOM walking
const QUICK = new RegExp("[$^×23\\r\\n" + FF + BSP + TAB + "]");
function handleText(t) {
  const p = t.parentElement;
  if (!p || !p.closest(SEL) || p.closest(SKIP)) return;
  let text = t.nodeValue;
  if (!QUICK.test(text)) return;
  let changed = false;
  const fixed = repair(text);
  if (fixed !== text) { text = fixed; changed = true; }
  if (text.includes(TAB)) { text = text.split(TAB).filter((c) => c.trim()).join(" – "); changed = true; }   // column gap inside an option / flat text
  let html = "", last = 0;
  const plain = (chunk) => { const f = plainFix(chunk); if (f !== null) changed = true; return f !== null ? f : esc(chunk); };
  for (const m of text.matchAll(MATH_RE)) {
    if (!looksLikeMath(m[1])) continue;
    html += plain(text.slice(last, m.index));
    html += `<span class="mf-tex" data-tex="${esc(m[1])}">${esc(m[0])}</span>`;
    last = m.index + m[0].length; changed = true;
  }
  html += plain(text.slice(last));
  if (!changed) return;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const mathSpans = [...tpl.content.querySelectorAll(".mf-tex")];
  t.replaceWith(tpl.content);
  if (mathSpans.length) typeset(mathSpans);
}

function stripQuestionNumber(qt) {
  const first = qt.querySelector(".q-line");
  if (!first || first.dataset.qn) return;
  first.dataset.qn = "1";
  const t = first.firstChild;
  if (t && t.nodeType === 3) t.nodeValue = t.nodeValue.replace(/^\s*\d{1,3}\.\s+(?=\S)/, "");
}

function scan(node) {
  if (node.nodeType === 3) { handleText(node); return; }
  if (node.nodeType !== 1 || node.closest(SKIP)) return;
  if (!node.closest(SEL) && !node.querySelector(SEL)) return;
  const qts = node.matches(".question-text") ? [node] : [...node.querySelectorAll(".question-text")];
  qts.forEach((qt) => { stripQuestionNumber(qt); tabTables(qt); });
  const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const list = [];
  while (w.nextNode()) list.push(w.currentNode);
  list.forEach(handleText);
}

let queued = new Set(), scheduled = false;
function flush() {
  scheduled = false;
  const nodes = [...queued]; queued = new Set();
  nodes.forEach((n) => { if (n.isConnected) scan(n); });
}
export function initMathFmt() {
  if (window.__mathfmt) return;
  window.__mathfmt = true;
  new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach((n) => queued.add(n));
    if (!scheduled && queued.size) { scheduled = true; setTimeout(flush, 0); }   // (not rAF: it never fires in a background tab)
  }).observe(document.body, { childList: true, subtree: true });
  scan(document.body);
}
initMathFmt();
