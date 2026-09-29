// Community features backed by Firestore (see firestore.rules): mock-test leaderboard with rank & percentile,
// per-question discussion / doubt threads, and referral tracking.
// NOTE on trust: scores are written by the student's browser (this is a static site; the Cloud Function that could
// re-score server-side is not deployed), so the leaderboard is a friendly practice board, not a proctored one.
// The rules bound what can be written (own document only, sane score range, best score kept).

import { doc, getDoc, setDoc, getDocs, addDoc, deleteDoc, collection, query, where, orderBy, limit, getCountFromServer, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db, getCurrentUser, authReady, showAuthModal } from "./auth.js?v=2";
import { hash36 } from "./userdata.js?v=2";

const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const clean = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);

// ---------------------------------------------------------------- display name (opt-in)
export function getDisplayName() { return lsGet("lb:name") || ""; }
export function setDisplayName(n) { lsSet("lb:name", clean(n, 24)); }

/** First time only: ask what name to show on leaderboards / discussions (empty = stay anonymous). */
export function ensureDisplayName() {
  let n = getDisplayName();
  if (n || lsGet("lb:asked")) return n || "Student";
  lsSet("lb:asked", "1");
  const v = prompt("लीडरबोर्ड/चर्चा में कौन-सा नाम दिखाएं? (खाली छोड़ने पर 'Student' दिखेगा — बाद में बदल सकते हैं)") || "";
  setDisplayName(v);
  return getDisplayName() || "Student";
}

async function user({ prompt: ask = false } = {}) {
  await authReady;
  let u = getCurrentUser();
  if (!u && ask) u = await showAuthModal({ reason: "यह सुविधा इस्तेमाल करने के लिए पहले साइन इन करें।" });
  return u || null;
}

// ---------------------------------------------------------------- leaderboard (F16)
const boardId = (examSlug, mockId) => `${examSlug}__${mockId}`;

/** Stores this attempt if it beats the student's best on this fixed paper; returns the best score on record. */
export async function submitScore(examSlug, mockId, r) {
  const u = await user();
  if (!u) return null;
  const ref = doc(db, "boards", boardId(examSlug, mockId), "scores", u.uid);
  try {
    const prev = await getDoc(ref);
    if (prev.exists() && prev.data().score >= r.score) return prev.data().score;
    await setDoc(ref, {
      uid: u.uid, name: ensureDisplayName(), score: Math.round(r.score * 100) / 100, correct: r.correct, wrong: r.wrong,
      total: r.total, timeSec: Math.round(r.timeSec || 0), ts: serverTimestamp(),
    });
    return r.score;
  } catch (e) {
    console.warn("Could not save leaderboard score (best-effort):", e);
    return null;
  }
}

/** {rank, total, percentile} for a score on one fixed paper (null if the board can't be read). */
export async function getRank(examSlug, mockId, score) {
  try {
    const coll = collection(db, "boards", boardId(examSlug, mockId), "scores");
    const [tot, gt] = await Promise.all([
      getCountFromServer(coll),
      getCountFromServer(query(coll, where("score", ">", Math.round(score * 100) / 100))),
    ]);
    const total = tot.data().count, greater = gt.data().count;
    return { rank: greater + 1, total, percentile: total > 1 ? Math.round(((total - greater - 1) / (total - 1)) * 1000) / 10 : null };
  } catch (e) {
    return null;
  }
}

export async function topScores(examSlug, mockId, n = 10) {
  try {
    const snap = await getDocs(query(collection(db, "boards", boardId(examSlug, mockId), "scores"), orderBy("score", "desc"), limit(n)));
    return snap.docs.map((d) => d.data());
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------- discussion / doubts (F41, F33)
/** One thread per real question (keyed by its content key, so the same question shares a thread across exams). */
export const threadKey = (q) => q.qkey || hash36(q.id);

export async function loadComments(q) {
  try {
    const snap = await getDocs(query(collection(db, "discussions", threadKey(q), "comments"), orderBy("ts", "asc"), limit(60)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    return null; // null = board not readable (rules not published yet)
  }
}

export async function postComment(q, text, kind = "comment") {
  const u = await user({ prompt: true });
  if (!u) return false;
  const t = clean(text, 500);
  if (t.length < 2) return false;
  try {
    await addDoc(collection(db, "discussions", threadKey(q), "comments"), {
      uid: u.uid, name: ensureDisplayName(), text: t, kind: kind === "doubt" ? "doubt" : "comment", ts: serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.warn("Could not post comment:", e);
    return false;
  }
}

export async function deleteComment(q, id) {
  try { await deleteDoc(doc(db, "discussions", threadKey(q), "comments", id)); return true; } catch (e) { return false; }
}

// ---------------------------------------------------------------- referrals (F37)
export const referralCodeFor = (uid) => (hash36(uid) + hash36(uid + "rgk")).toUpperCase().replace(/[^A-Z0-9]/g, "").padEnd(8, "0").slice(0, 8);

/** Remember ?ref=CODE from an invite link until the student signs up. */
export function captureRefFromUrl() {
  try {
    const c = new URLSearchParams(location.search).get("ref");
    if (c && /^[A-Z0-9]{6,12}$/i.test(c)) lsSet("ref", c.toUpperCase());
  } catch (e) {}
}

/** Creates (once) this student's public referral code document and returns the code. */
export async function ensureReferralCode() {
  const u = await user();
  if (!u) return null;
  const code = referralCodeFor(u.uid);
  try {
    const ref = doc(db, "referralCodes", code);
    if (!(await getDoc(ref)).exists()) await setDoc(ref, { uid: u.uid, ts: serverTimestamp() });
  } catch (e) { /* rules not published yet: the code still works for link sharing */ }
  return code;
}

/** If this browser arrived via an invite link, credit the referrer once when the new student is signed in. */
export async function recordReferralJoin() {
  const code = lsGet("ref");
  const u = await user();
  if (!code || !u || lsGet(`refdone:${u.uid}`)) return;
  try {
    await setDoc(doc(db, "referralCodes", code, "joined", u.uid), { uid: u.uid, ts: serverTimestamp() });
    lsSet(`refdone:${u.uid}`, "1");
  } catch (e) { /* invalid/own code or rules not published: ignore */ }
}

export async function referralCount(code) {
  try { return (await getCountFromServer(collection(db, "referralCodes", code, "joined"))).data().count; } catch (e) { return null; }
}
