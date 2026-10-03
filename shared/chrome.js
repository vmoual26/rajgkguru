// Shared site header (logo, brand, nav tabs, auth badge) and footer (social
// links, query form, policies, copyright) -- rendered by every page into a
// <header id="site-header"> / <footer id="site-footer"> placeholder, so the
// whole site's chrome lives in exactly one place instead of being duplicated
// across every HTML file. Visual language (gradient, logo, footer shape)
// takes inspiration from aldhruacademy.com's own design; the multi-page nav
// structure itself does not, since that site is single-page.
import { renderAuthBadge } from "./auth.js?v=3";
import { captureRefFromUrl, recordReferralJoin } from "./community.js?v=1";

// Individual exam links deliberately stay OUT of this fixed nav -- as the
// number of exams per board grows, listing each one here doesn't scale.
// "RPSC"/"RMSSB" are the permanent top-level entries; each opens that
// board's own exam list (rpsc.html / rmssb.html).
const NAV_LINKS = [
  { href: "/", label: "होम", key: "home" },
  { href: "/dashboard.html", label: "डैशबोर्ड", key: "dashboard" },
  { href: "/rpsc.html", label: "RPSC", key: "rpsc" },
  { href: "/rmssb.html", label: "RMSSB", key: "rmssb" },
  { href: "/bookmarks.html", label: "बुकमार्क", key: "bookmarks" },
  { href: "/pricing.html", label: "प्लान", key: "pricing" },
  { href: "/blog/", label: "ब्लॉग", key: "blog" },
  { href: "/#contact", label: "संपर्क करें", key: "contact" },
];

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** activeKey: which NAV_LINKS.key to highlight, or null for none. */
export function renderHeader(container, activeKey = null) {
  container.innerHTML = `
    <div class="site-header-inner">
      <a href="/" class="site-brand">
        <img src="/shared/logo.png" alt="Aldhru Academy" class="site-logo">
        <span class="site-brand-text">ALDHRU<span class="accent">ACADEMY</span></span>
      </a>
      <button class="nav-toggle" id="nav-toggle" aria-label="मेन्यू खोलें">☰</button>
      <nav class="site-nav" id="site-nav">
        ${NAV_LINKS.map((l) => `<a href="${l.href}" class="${l.key === activeKey ? "active" : ""}">${l.label}</a>`).join("")}
      </nav>
      <button class="lang-toggle" id="lang-toggle" title="Language">EN</button>
      <div class="site-auth" id="site-auth-badge"></div>
    </div>
  `;
  renderAuthBadge(container.querySelector("#site-auth-badge"));
  const toggle = container.querySelector("#nav-toggle");
  const nav = container.querySelector("#site-nav");
  toggle.onclick = () => nav.classList.toggle("open");
}

/** showQuery: the "कोई सवाल है?" contact form -- deliberately opt-in, not
 * shown on every page by default. It was originally rendered unconditionally
 * as part of the footer, which meant it also showed up mid-test on
 * test.html and on every other page, not just the homepage where it
 * actually belongs. Only index.html passes { showQuery: true }. */
export function renderFooter(container, { showQuery = false } = {}) {
  const queryFormHtml = !showQuery ? "" : `
    <div id="contact" class="footer-query">
      <div class="footer-query-inner">
        <h2>कोई सवाल है? 🤔</h2>
        <p>नीचे फॉर्म भरें, हमारी टीम जल्द ही आपसे संपर्क करेगी।</p>
        <form class="query-form" id="query-form">
          <div class="form-block">
            <label>आपका पूरा नाम *</label>
            <input type="text" id="q-name" required>
          </div>
          <div class="form-block">
            <label>मोबाइल नंबर *</label>
            <input type="tel" id="q-phone" pattern="[6-9][0-9]{9}" required>
          </div>
          <div class="form-block span-2">
            <label>ईमेल आईडी *</label>
            <input type="email" id="q-email" required>
          </div>
          <div class="form-block span-2">
            <label>सवाल / संदेश *</label>
            <textarea id="q-message" rows="2" required></textarea>
          </div>
          <button type="submit" class="btn btn-primary span-2">अनुरोध भेजें 🚀</button>
        </form>
      </div>
    </div>`;

  container.innerHTML = `
    ${queryFormHtml}
    <div class="site-footer">
      <div class="site-footer-inner">
        <div class="footer-brand">
          <img src="/shared/logo.png" alt="Aldhru Academy" class="site-logo">
          <span>ALDHRU ACADEMY</span>
        </div>
        <p class="footer-tagline">राजस्थान की प्रतियोगी परीक्षाओं के लिए भरोसेमंद टेस्ट सीरीज़।</p>
        <div class="footer-social">
          <a href="https://www.youtube.com/@AldhruAcademyRAJGK" target="_blank" rel="noopener">YouTube</a>
          <a href="https://rajgkguru.aldhruacademy.com/" target="_blank" rel="noopener">मुख्य वेबसाइट</a>
        </div>
        <p class="footer-legal">
          <a href="/privacy.html">Privacy Policy</a> · <a href="/terms.html">Terms &amp; Conditions</a> · <a href="/refund.html">Refund &amp; Cancellation</a> · <a href="/about.html">About &amp; our quality process</a> · <a href="/blog/">Blog</a>
        </p>
        <p class="footer-support">📧 सपोर्ट: <a href="mailto:support@aldhruacademy.com">support@aldhruacademy.com</a></p>
        <p class="footer-copyright">© ${new Date().getFullYear()} Aldhru Academy. सर्वाधिकार सुरक्षित (All Rights Reserved).</p>
      </div>
    </div>
  `;

  if (!showQuery) return;
  const form = container.querySelector("#query-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = form.querySelector("#q-name").value.trim();
    const phone = form.querySelector("#q-phone").value.trim();
    const email = form.querySelector("#q-email").value.trim();
    const message = form.querySelector("#q-message").value.trim();
    const body = `नाम: ${name}\nमोबाइल: ${phone}\nईमेल: ${email}\n\nसंदेश:\n${message}`;
    window.location.href = `mailto:support@aldhruacademy.com?subject=${encodeURIComponent("RAJ G.K. GURU -- नई पूछताछ")}&body=${encodeURIComponent(body)}`;
  });
}


// ---------------------------------------------------------------- site-wide services (run once per page load)
captureRefFromUrl();          // remember ?ref=CODE from an invite link
recordReferralJoin();         // credit the referrer once the new student is signed in
import("./i18n.js?v=3").then((m) => m.initI18n()).catch(() => {});   // Hindi <-> English UI toggle
import("./mathfmt.js?v=1").catch(() => {});                              // formulas ($...$ LaTeX, powers, units) in question text

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
function showOfflineBanner(on) {
  let el = document.getElementById("offline-banner");
  if (on && !el) {
    el = document.createElement("div"); el.id = "offline-banner"; el.className = "offline-banner";
    el.textContent = "आप ऑफ़लाइन हैं — देखे हुए टेस्ट चलते रहेंगे, नतीजे इंटरनेट आने पर सेव होंगे।";
    document.body.appendChild(el);
  } else if (!on && el) el.remove();
}
window.addEventListener("offline", () => showOfflineBanner(true));
window.addEventListener("online", () => showOfflineBanner(false));
if (!navigator.onLine) window.addEventListener("DOMContentLoaded", () => showOfflineBanner(true));

// Test/results content is never printable (see the @media print rule in features.css) --
// paid students use the watermarked "Download PDF" button instead. This class-based toggle is
// the broad-compatibility path; the CSS file's own :has() selectors are a fallback for a
// browser that prints without firing beforeprint.
window.addEventListener("beforeprint", () => {
  document.body.classList.toggle("print-block-test", !!(document.querySelector(".question-card") || document.getElementById("results-extras")));
});

// ---------------------------------------------------------------- full-screen / focus mode on the test player
// A button next to the test title makes the browser full screen (app-like, no address bar). Browsers that have no
// Fullscreen API (iPhone Safari) or refuse it get "focus mode": the site header/footer are simply hidden.
function initFullscreenToggle() {
  if (!/\/test\.html$/.test(location.pathname)) return;
  const h1 = document.getElementById("test-title");
  if (!h1 || document.getElementById("fs-toggle")) return;
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  const native = !!(request && exit && (document.fullscreenEnabled ?? document.webkitFullscreenEnabled));
  let en = false;
  try { en = localStorage.getItem("lang") === "en"; } catch (e) {}
  const T = en
    ? { on: "Exit full screen", off: "Full screen", softOn: "Exit focus mode", softOff: "Focus mode" }
    : { on: "फुल स्क्रीन बंद करें", off: "फुल स्क्रीन", softOn: "फ़ोकस मोड बंद करें", softOff: "फ़ोकस मोड" };

  const row = document.createElement("div");
  row.className = "fs-row";
  h1.parentNode.insertBefore(row, h1);
  row.appendChild(h1);
  const btn = document.createElement("button");
  btn.type = "button"; btn.id = "fs-toggle"; btn.className = "fs-toggle"; btn.setAttribute("data-notranslate", "");
  row.appendChild(btn);

  document.body.classList.add("has-fs-toggle");   // hides the old unlabelled ⛶ icon in the player bar (one control, not two)
  let soft = false;
  const nativeOn = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const isOn = () => nativeOn() || soft;
  function sync() {
    const on = isOn();
    document.body.classList.toggle("fs-mode", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    const label = native && !soft ? (on ? T.on : T.off) : (on ? T.softOn : T.softOff);
    btn.innerHTML = `<span aria-hidden="true">${on ? "✕" : "⛶"}</span><span>${label}</span>`;
    btn.title = label;
  }
  // Ask the browser for real full screen; if it refuses, or silently ignores the request (in-app browsers / WebViews),
  // fall back to focus mode after a short wait instead of leaving the button looking dead.
  const enterNative = () => new Promise((resolve) => {
    let t;
    const done = () => {
      document.removeEventListener("fullscreenchange", done); document.removeEventListener("webkitfullscreenchange", done);
      clearTimeout(t); resolve(nativeOn());
    };
    document.addEventListener("fullscreenchange", done); document.addEventListener("webkitfullscreenchange", done);
    t = setTimeout(done, 700);
    try { const p = request.call(root); if (p && p.catch) p.catch(done); } catch (e) { done(); }
  });
  btn.addEventListener("click", async () => {
    if (soft) soft = false;
    else if (nativeOn()) { try { await exit.call(document); } catch (e) {} }
    else if (!native || !(await enterNative())) soft = true;
    sync();
  });
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("webkitfullscreenchange", sync);
  sync();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initFullscreenToggle);
else initFullscreenToggle();
