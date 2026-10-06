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

// 2026-10-06: the fact and the question are no longer about the same thing on the same day. TODAY's fact is
// entry[today].fact; TODAY's question is the one built from YESTERDAY's fact (entry[yesterday].q), so a student reads a
// fact today and is quizzed on it tomorrow -- a built-in next-day recall.
const _months = {};
async function entryFor(date) {
  const m = pad(date.getMonth() + 1);
  try {
    if (!_months[m]) {
      const r = await fetch(`/qotd/m${m}.json`);
      _months[m] = r.ok ? await r.json() : { entries: {} };
    }
    const e = _months[m].entries;
    return e[String(date.getDate())] || Object.values(e)[0] || null;
  } catch (err) { return null; }
}

export async function renderDaily(root) {
  if (!root) return;
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const [entry, prev] = await Promise.all([entryFor(today), entryFor(yesterday)]);
  if (!entry) return;
  const qEntry = prev || entry;          // fall back to today's own question only if yesterday's data is unavailable
  const q = qEntry.q;

  const key = `qotd:${isoDay(today)}`;
  const streakLabel = () => { const n = currentStreak(today); return n ? `🔥 ${n} दिन की स्ट्रीक` : ""; };

  root.innerHTML = `
    <div class="daily-wrap">
      <div class="daily-card">
        <div class="daily-title"><span>💡 आज का तथ्य</span><span class="daily-new">नया</span></div>
        <div class="daily-fact">${escapeHtml(entry.fact || "")}</div>
        <span class="daily-fact-tag">${escapeHtml(entry.subject || "")}</span>
        <p class="daily-hint">इसे याद रखें — कल इसी तथ्य पर प्रश्न पूछा जाएगा।</p>
      </div>
      <div class="daily-card">
        <div class="daily-title"><span>🧠 आज का प्रश्न</span><span class="daily-streak" id="daily-streak">${streakLabel()}</span></div>
        <p class="daily-hint daily-hint-top">कल के तथ्य पर आधारित — देखें कितना याद है।</p>
        <p class="daily-q">${escapeHtml(q.question)}</p>
        <div class="daily-opts">${q.options.map((o, i) => `<button class="daily-opt" data-i="${i + 1}">${escapeHtml(o)}</button>`).join("")}</div>
        <div class="daily-result" id="daily-result"></div>
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
      ${qEntry.fact ? `<div>💡 <b>कल का तथ्य:</b> ${escapeHtml(qEntry.fact)}</div>` : (qEntry.explanation ? `<div>${escapeHtml(qEntry.explanation)}</div>` : "")}
      ${qEntry.slug ? `<div style="margin-top:8px"><a href="${qEntry.slug}/">और अभ्यास करें →</a></div>` : ""}`;
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
