// Exam search shared by the home page and the RPSC / RMSSB pages: type "पटवारी", "ras", "si", "lecturer"... and get matching exams
// instantly (client-side, over exams.json). Extra Hindi/English keywords per exam make the common spellings work.

const KEYWORDS = {
  "raj-state-and-sub-services-comb-comp-exam-ras-rts": "ras rts आरएएस आरटीएस राज्य प्रशासनिक सेवा rpsc प्रीलिम्स prelims",
  "patwari": "पटवारी patwar rmssb",
  "sub-inspector-comb-comp-exam": "si पुलिस उप निरीक्षक सब इंस्पेक्टर police",
  "school-lecturer": "lecturer व्याख्याता प्रथम श्रेणी 1st grade school",
  "sr-teacher-gr-2": "senior teacher वरिष्ठ अध्यापक शिक्षक 2nd grade second grade",
  "sr-teacher-sanskrit-education": "sanskrit संस्कृत वरिष्ठ अध्यापक teacher",
  "sr-teacher-gr-ii-special-education": "special विशेष शिक्षा teacher",
  "primary-upper-primary-teacher": "reet teacher शिक्षक प्राथमिक उच्च प्राथमिक 3rd grade third grade",
  "village-development-officer": "vdo ग्राम विकास अधिकारी vdo",
  "cet-senior-secondary": "cet सीईटी 12th senior secondary",
  "common-eligibility-test-graduation-level": "cet सीईटी graduation स्नातक",
  "forester-forest-guard": "वनरक्षक वनपाल forest guard forester",
  "acf-forest-range-officer-gr1": "acf वन रेंज अधिकारी range officer",
  "fourth-class-employee": "class 4 चतुर्थ श्रेणी peon चपरासी",
  "lab-assistant": "लैब सहायक lab",
  "animal-attendant": "पशु परिचर",
  "live-stock-assistant": "पशुधन सहायक livestock",
  "agriculture-supervisor": "कृषि पर्यवेक्षक agri",
  "supervisor-woman-anganwadi": "आंगनबाड़ी महिला पर्यवेक्षक supervisor",
  "stenographer-rpsc": "steno आशुलिपिक rpsc",
  "stenographer-rmssb": "steno आशुलिपिक rmssb",
  "assistant-engineer-comb-comp-exam": "ae सहायक अभियंता engineer",
  "junior-engineer-jen": "jen je जेईएन कनिष्ठ अभियंता engineer",
  "headmaster-praveshika-sanskrit": "प्रधानाध्यापक headmaster praveshika",
  "protection-officer": "संरक्षण अधिकारी po",
  "assistant-professor-college-education": "सहायक आचार्य प्रोफेसर college lecturer",
  "pti-physical-training-instructor": "pti शारीरिक शिक्षक physical",
  "junior-instructor": "कनिष्ठ अनुदेशक instructor",
};

const norm = (s) => String(s ?? "").toLowerCase();

export function haystack(e) {
  return norm(`${e.title} ${e.slug.replace(/-/g, " ")} ${e.board} ${KEYWORDS[e.slug] || ""}`);
}

/** Every whitespace-separated token of `term` must appear somewhere in the exam's text. */
export function matchExams(exams, term) {
  const toks = norm(term).trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  // very short Latin tokens ("si", "ae", "po") must match a whole word, or "si" would hit every "assistant"
  const hit = (h, t) => (/^[a-z0-9]{1,2}$/.test(t) ? new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(h) : h.includes(t));
  return exams.filter((e) => { const h = haystack(e); return toks.every((t) => hit(h, t)); });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Dropdown search. exams: live exam objects; hrefFor(e) -> link. */
export function mountDropdownSearch({ input, results, exams, hrefFor }) {
  const render = () => {
    const term = input.value.trim();
    if (!term) { results.hidden = true; results.innerHTML = ""; return; }
    const m = matchExams(exams, term).slice(0, 8);
    results.innerHTML = m.length
      ? m.map((e) => `<a class="sr-row" href="${hrefFor(e)}"><span class="sr-title">${esc(e.title)}</span><span class="pill ${e.board === "RPSC" ? "pill-subject" : "pill-free"}">${esc(e.board)}</span></a>`).join("")
      : `<div class="sr-empty">"${esc(term)}" नहीं मिली — RPSC या RMSSB की पूरी सूची देखें।</div>`;
    results.hidden = false;
  };
  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { const a = results.querySelector("a.sr-row"); if (a) location.href = a.href; }
    if (ev.key === "Escape") results.hidden = true;
  });
  document.addEventListener("click", (ev) => { if (!results.contains(ev.target) && ev.target !== input) results.hidden = true; });
  return { setTerm: (t) => { input.value = t; input.focus(); render(); } };
}
