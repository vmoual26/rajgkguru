// Display-only mirror of cloud_functions/test_series/exam_prices.json (the Cloud Function is
// the only source of truth for what a card is actually charged -- it recomputes the price
// server-side from plan+duration+exam_slugs, never trusts a client-sent amount). This file
// exists purely so the buy buttons can SHOW a price before checkout opens. Keep the numbers
// here in sync with exam_prices.json by hand when pricing changes.
export const PREMIUM_SLUGS = new Set(["raj-state-and-sub-services-comb-comp-exam-ras-rts", "sub-inspector-comb-comp-exam", "school-lecturer", "sr-teacher-gr-2"]);
export const PRICES = {
  single: { standard: { 3: 349, 6: 499, 12: 699 }, premium: { 3: 449, 6: 649, 12: 899 } },
  bundle3: { 3: 699, 6: 999, 12: 1500 },
  all_access: { 3: 999, 6: 1599, 12: 2499 },
};
export const priceOf = (slug, months) => PRICES.single[PREMIUM_SLUGS.has(slug) ? "premium" : "standard"][months];

/** Small "choose your plan length" modal (uses the .fx-overlay/.fx-modal styles from
 * features.css, already loaded globally by shared/insights.js). Calls onPick(months) once. */
export function openDurationPicker({ examSlug, examTitle }, onPick) {
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rows = [3, 6, 12].map((m) => `<button class="fx-tool" data-m="${m}" style="align-items:stretch;text-align:left">
      <span style="font-size:1.1rem">${m} महीने</span><span style="font-size:0.82rem;color:var(--text-dim)">₹${priceOf(examSlug, m)}${m === 12 ? " · सबसे किफ़ायती" : ""}</span></button>`).join("");
  const ov = document.createElement("div");
  ov.className = "fx-overlay";
  ov.innerHTML = `<div class="fx-modal"><button class="fx-close" aria-label="close">&times;</button>
    <h3 style="margin:0 0 4px">${E(examTitle)}</h3>
    <p class="small" style="margin:0 0 12px">कितने महीनों के लिए Access चाहिए?</p>
    <div style="display:grid;gap:8px">${rows}</div>
    <p class="small" style="margin-top:12px">सभी परीक्षाओं के लिए एक साथ खरीदना चाहते हैं? <a href="/pricing.html">प्लान देखें →</a></p></div>`;
  const close = () => ov.remove();
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  ov.querySelector(".fx-close").onclick = close;
  ov.querySelectorAll("[data-m]").forEach((b) => { b.onclick = () => { close(); onPick(Number(b.dataset.m)); }; });
  document.body.appendChild(ov);
}
