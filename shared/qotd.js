// Home-page "Question of the Day" + "Fact of the Day".
// Data: /qotd/mMM.json (one file per month, entries keyed by day-of-month; built by scripts/build_qotd.py
// from the FREE pools only, so nothing paid is ever exposed). The entry for today is picked by date, so
// every visitor sees the same question on the same day. Streak lives in localStorage (per device).

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

function bumpStreak(today) {
  let st = { last: "", count: 0 };
  try { st = JSON.parse(safeGet("qotd:streak") || "") || st; } catch (e) {}
  const y = new Date(today); y.setDate(y.getDate() - 1);
  if (st.last === isoDay(today)) return st.count;
  st = { last: isoDay(today), count: st.last === isoDay(y) ? st.count + 1 : 1 };
  safeSet("qotd:streak", JSON.stringify(st));
  return st.count;
}

function currentStreak(today) {
  try {
    const st = JSON.parse(safeGet("qotd:streak") || "");
    const y = new Date(today); y.setDate(y.getDate() - 1);
    if (st && (st.last === isoDay(today) || st.last === isoDay(y))) return st.count;
  } catch (e) {}
  return 0;
}

export async function renderDaily(root) {
  if (!root) return;
  const today = new Date();
  let entry;
  try {
    const r = await fetch(`/qotd/m${pad(today.getMonth() + 1)}.json`);
    if (!r.ok) return;
    const data = await r.json();
    entry = data.entries[String(today.getDate())] || Object.values(data.entries)[0];
  } catch (e) { return; }
  if (!entry) return;

  const key = `qotd:${isoDay(today)}`;
  const q = entry.q;
  const streakLabel = () => { const n = currentStreak(today); return n ? `🔥 ${n} दिन की स्ट्रीक` : ""; };

  root.innerHTML = `
    <div class="daily-wrap">
      <div class="daily-card">
        <div class="daily-title"><span>🧠 आज का प्रश्न</span><span class="daily-streak" id="daily-streak">${streakLabel()}</span></div>
        <p class="daily-q">${escapeHtml(q.question)}</p>
        <div class="daily-opts">${q.options.map((o, i) => `<button class="daily-opt" data-i="${i + 1}">${escapeHtml(o)}</button>`).join("")}</div>
        <div class="daily-result" id="daily-result"></div>
      </div>
      <div class="daily-card">
        <div class="daily-title"><span>💡 आज का तथ्य</span></div>
        <div class="daily-fact">${escapeHtml(entry.fact || "")}</div>
        <span class="daily-fact-tag">${escapeHtml(entry.subject || "")}</span>
      </div>
    </div>`;

  const buttons = [...root.querySelectorAll(".daily-opt")];
  const resultBox = root.querySelector("#daily-result");
  const reveal = (picked) => {
    buttons.forEach((b) => {
      const i = Number(b.dataset.i);
      b.disabled = true;
      if (i === q.correct) b.classList.add("correct");
      else if (i === picked) b.classList.add("wrong");
    });
    const ok = picked === q.correct;
    resultBox.innerHTML = `<strong>${ok ? "✅ बिल्कुल सही!" : "❌ गलत — सही उत्तर हाइलाइट किया गया है।"}</strong>
      ${entry.explanation ? `<div>${escapeHtml(entry.explanation)}</div>` : ""}
      ${entry.slug ? `<div style="margin-top:8px"><a href="${entry.slug}/">और अभ्यास करें →</a></div>` : ""}`;
  };
  const done = Number(safeGet(key));
  if (done) reveal(done);
  buttons.forEach((b) => {
    b.onclick = () => {
      const picked = Number(b.dataset.i);
      safeSet(key, String(picked));
      bumpStreak(today);
      root.querySelector("#daily-streak").textContent = streakLabel();
      reveal(picked);
    };
  });
}
