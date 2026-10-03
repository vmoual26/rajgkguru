// Entitlement checks + saved progress (Firestore) + the purchase flow
// (Cloud Functions + Razorpay Checkout.js). All reads/writes go through the
// new isolated project's Firestore -- see firebase-config.js.

import { doc, getDoc, setDoc, deleteDoc, deleteField, arrayUnion, collection, addDoc, getDocs, query, orderBy, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db, getCurrentUser, showAuthModal, authReady, ensureAnyUser, secureAccountWithEmail, friendlyError } from "./auth.js?v=2";
import { CLOUD_FUNCTIONS_BASE_URL } from "./firebase-config.js?v=2";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** Every purchase (single exam, 3-bundle member, or the All-Access Pass) is stored the same
 * way: purchases.{key} = "YYYY-MM-DD" (expiry date, written by the webhook), or `true` for a
 * legacy/lifetime grant from before duration plans existed. key is the exam slug, or
 * ALL_ACCESS for the pass. */
export const ALL_ACCESS = "all_access";
export function isActive(v) {
  if (v === true) return true;
  return typeof v === "string" && v >= new Date().toISOString().slice(0, 10);
}
export const allAccessActive = isActive; // old name, kept so nothing importing it breaks

/** True if the signed-in user holds an unexpired purchase of this exam specifically, or an
 * unexpired All-Access Pass. Always false if signed out -- callers should gate on this, not
 * on auth state alone, since a signed-in user may simply not have bought this exam yet. */
export async function checkEntitlement(examSlug) {
  await authReady;
  const user = getCurrentUser();
  if (!user) return false;
  const p = (await getDoc(doc(db, "users", user.uid))).data()?.purchases || {};
  return isActive(p[examSlug]) || isActive(p[ALL_ACCESS]);
}

/** {active, expires} for the signed-in student's All-Access Pass. */
export async function getAllAccess() {
  await authReady;
  const user = getCurrentUser();
  if (!user) return { active: false };
  try {
    const v = (await getDoc(doc(db, "users", user.uid))).data()?.purchases?.[ALL_ACCESS];
    return { active: isActive(v), expires: typeof v === "string" ? v : null };
  } catch (e) { return { active: false }; }
}

/** Every currently-active purchase the signed-in student holds: [{slug, expires}], slug ===
 * ALL_ACCESS for the pass. Empty if signed out or nothing active. Powers the dashboard's
 * "my plans" list and the pricing page's "already own this" states. */
export async function getMyPurchases() {
  await authReady;
  const user = getCurrentUser();
  if (!user) return [];
  try {
    const p = (await getDoc(doc(db, "users", user.uid))).data()?.purchases || {};
    return Object.entries(p).filter(([, v]) => isActive(v)).map(([slug, v]) => ({ slug, expires: typeof v === "string" ? v : null }));
  } catch (e) { return []; }
}

/** A persistent per-browser id (not per-account) used only to enforce the paid-content
 * device cap (shared/DEPLOYMENT.md: MAX_DEVICES) -- sent with every paid-pool fetch so the
 * server can tell "known device" from "new device" without any personal data. */
export function getDeviceId() {
  const KEY = "device-id";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch (e) {
    return "no-storage"; // private-browsing fallback -- still works, just registers as a fresh device every visit
  }
}

/** This account's registered devices (dashboard's Devices panel): [{id, firstSeen, lastSeen}].
 * Devices are only ever CREATED by the paid-pool Cloud Function (so the cap can't be
 * bypassed client-side); a student may read and remove their own to free a slot. */
export async function listDevices() {
  await authReady;
  const user = getCurrentUser();
  if (!user) return [];
  try {
    const snap = await getDocs(collection(db, "users", user.uid, "devices"));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) { return []; }
}

export async function removeDevice(deviceId) {
  await authReady;
  const user = getCurrentUser();
  if (!user) return false;
  try { await deleteDoc(doc(db, "users", user.uid, "devices", deviceId)); return true; } catch (e) { return false; }
}

/** Fetches this exam's paid question pool from the Cloud Function -- NEVER
 * from a static file. The pool only lives inside get_paid_pool's own
 * deployment (cloud_functions/test_series/paid_pools/), never in this
 * public repo, so there's nothing for an unauthenticated request to find:
 * the function itself re-checks the caller's purchase in Firestore before
 * returning anything. Throws if the caller isn't signed in or hasn't
 * purchased -- callers should already know hasPaidAccess before calling
 * this (checkEntitlement()), this is a second, authoritative check, not the
 * only one. Returns {questions: []} shaped output only never here -- if the
 * checks pass, the pool comes back for real. */
const _paidPoolCache = new Map();
export function fetchPaidPool(examSlug) {
  // One download per exam per page load: several callers ask for the pool in a row.
  if (!_paidPoolCache.has(examSlug)) {
    const p = fetchPaidPoolUncached(examSlug);
    p.catch(() => _paidPoolCache.delete(examSlug));
    _paidPoolCache.set(examSlug, p);
  }
  return _paidPoolCache.get(examSlug);
}

async function fetchPaidPoolUncached(examSlug) {
  await authReady;
  const user = getCurrentUser();
  if (!user) throw new Error("Not signed in");
  const idToken = await user.getIdToken();
  const res = await fetch(`${CLOUD_FUNCTIONS_BASE_URL}/get_paid_pool?exam_slug=${encodeURIComponent(examSlug)}`, {
    headers: { "Authorization": `Bearer ${idToken}`, "X-Device-Id": getDeviceId() },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Could not load paid content (${res.status})`);
    err.code = body.code;
    throw err;
  }
  return res.json();
}

/** Records one completed test (free or paid) to the signed-in user's
 * history. Silently does nothing if signed out -- progress-saving is a
 * bonus for logged-in students, never a requirement to use the free tier.
 * `attempt` may include `wrongIds`/`fixedIds` (question ids missed / gotten
 * right this attempt) -- when present, they're stored with the attempt for
 * history AND used to keep the exam's "needs practice" pool (see
 * getWrongQuestionIds) in sync: newly-wrong questions join it, questions
 * just answered correctly leave it, even if they were wrong before. */
export async function recordAttempt(examSlug, attempt) {
  await authReady;
  const user = getCurrentUser();
  if (!user) return;
  try {
    await addDoc(collection(db, "users", user.uid, "attempts"), {
      examSlug, ...attempt, timestamp: serverTimestamp(),
    });
  } catch (e) {
    // Offline / flaky network: keep the attempt on this device and resend it later (see flushPendingAttempts).
    console.warn("Could not save attempt yet -- queued for retry:", e);
    try {
      const q = JSON.parse(localStorage.getItem("pending-attempts") || "[]");
      q.push({ examSlug, attempt, at: Date.now() });
      localStorage.setItem("pending-attempts", JSON.stringify(q.slice(-50)));
    } catch (e2) {}
  }

  const { wrongIds = [], fixedIds = [] } = attempt;
  if (wrongIds.length || fixedIds.length) {
    const ids = {};
    wrongIds.forEach((qid) => { ids[qid] = true; });
    fixedIds.forEach((qid) => { ids[qid] = deleteField(); });
    try {
      await setDoc(doc(db, "users", user.uid, "wrongQuestions", examSlug), { ids }, { merge: true });
    } catch (e) {
      console.warn("Could not update wrong-question practice list (best-effort):", e);
    }
  }
}

/** Question ids the signed-in user has currently got wrong for this exam
 * (cleared as soon as they're answered correctly again) -- powers the
 * dashboard's "practice your wrong questions" feature. Empty if signed out
 * or nothing is wrong right now. */
export async function getWrongQuestionIds(examSlug) {
  await authReady;
  const user = getCurrentUser();
  if (!user) return [];
  try {
    const snap = await getDoc(doc(db, "users", user.uid, "wrongQuestions", examSlug));
    return Object.keys(snap.data()?.ids || {});
  } catch (e) {
    console.warn("Could not load wrong-question practice list:", e);
    return [];
  }
}

/** The signed-in student's set of already-seen question content keys (qkeys), shared by
 * every exam so a question practised in one exam is never repeated in another -- see the
 * seen-tracking notes in each exam's app.js. Empty if signed out or if Firestore rules
 * don't yet allow the users/{uid}/seen path (then per-browser tracking still applies). */
export async function loadCloudSeenKeys() {
  await authReady;
  const user = getCurrentUser();
  if (!user) return [];
  try {
    const snap = await getDoc(doc(db, "users", user.uid, "seen", "global"));
    return snap.data()?.keys || [];
  } catch (e) {
    console.warn("Could not load synced seen-questions (best-effort):", e);
    return [];
  }
}

/** Adds keys to the student's synced seen-set (arrayUnion, so concurrent devices merge
 * rather than overwrite). Silent no-op if signed out; failures never affect practice. */
export async function saveCloudSeenKeys(keys) {
  if (!keys.length) return;
  await authReady;
  const user = getCurrentUser();
  if (!user) return;
  try {
    await setDoc(doc(db, "users", user.uid, "seen", "global"),
      { keys: arrayUnion(...keys), updatedAt: serverTimestamp() }, { merge: true });
  } catch (e) {
    console.warn("Could not sync seen-questions (best-effort):", e);
  }
}

/** "Report a mistake" -- a student flags a wrong answer / badly rendered question. Stored in the
 * top-level `reports` collection (create-only for clients; read via the Admin SDK by
 * scripts/review_reports.py). Requires sign-in so reports are attributable and spam is limited.
 * Returns true if stored. */
export async function reportMistake(examSlug, q, reason, note) {
  await authReady;
  const user = getCurrentUser();
  if (!user) { showAuthModal(); return false; }
  try {
    await addDoc(collection(db, "reports"), {
      uid: user.uid,
      examSlug: String(examSlug).slice(0, 80),
      qid: String(q.id || "").slice(0, 120),
      qkey: String(q.qkey || "").slice(0, 40),
      reason: String(reason).slice(0, 30),
      note: String(note || "").slice(0, 500),
      stem: String((q.hindi || q.english || {}).question || "").slice(0, 300),
      createdAt: serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.warn("Could not send report:", e);
    return false;
  }
}

/** All of the signed-in user's completed attempts across every exam,
 * newest first -- powers the dashboard's stats and day-wise breakdown.
 * Fetched unfiltered (not per-exam) and grouped client-side so this never
 * needs a Firestore composite index. Empty if signed out. */
export async function getAllAttempts() {
  await authReady;
  const user = getCurrentUser();
  if (!user) return [];
  const snap = await getDocs(query(collection(db, "users", user.uid, "attempts"), orderBy("timestamp", "desc")));
  return snap.docs.map((d) => d.data());
}

function loadRazorpayScript() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Razorpay checkout script failed to load"));
    document.head.appendChild(s);
  });
}

/** Pay-first checkout details modal (2026-09-29, replaces requiring full registration
 * before checkout -- see main.py's module docstring for why). Collects just enough to
 * create the order and later email a receipt; never resolves on close/cancel, matching
 * showAuthModal's convention -- the caller's flow simply stops there. */
function showCheckoutDetailsModal({ title, prefillEmail } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "auth-backdrop";
    document.body.appendChild(backdrop);
    backdrop.innerHTML = `
      <div class="auth-modal">
        <button class="auth-close" aria-label="Close">&times;</button>
        <h2>${escapeHtml(title || "Buy Access")}</h2>
        <p class="sub">भुगतान से पहले अपनी जानकारी भरें — अभी पूरा खाता बनाने की ज़रूरत नहीं।</p>
        <div class="auth-field"><label>पूरा नाम</label><input type="text" id="co-name" autocomplete="name"></div>
        <div class="auth-field"><label>ईमेल</label><input type="email" id="co-email" autocomplete="email" value="${escapeHtml(prefillEmail || "")}"></div>
        <div class="auth-field"><label>मोबाइल नंबर</label><input type="tel" id="co-mobile" pattern="[6-9][0-9]{9}" maxlength="10" autocomplete="tel"></div>
        <div class="auth-error" id="co-error"></div>
        <button class="btn btn-primary btn-block" id="co-submit">भुगतान पर जाएं (Proceed to Pay)</button>
        <div class="auth-toggle">पहले से खाता है? <a href="#" id="co-signin">Sign in करें</a></div>
      </div>`;
    backdrop.querySelector(".auth-close").onclick = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
    backdrop.querySelector("#co-signin").onclick = async (e) => {
      e.preventDefault();
      backdrop.remove();
      const user = await showAuthModal({ reason: `${title} खरीदने के लिए साइन इन करें।` });
      if (user) resolve({ user, name: "", email: user.email || "", phone: "" });
    };
    backdrop.querySelector("#co-submit").onclick = async () => {
      const name = backdrop.querySelector("#co-name").value.trim();
      const email = backdrop.querySelector("#co-email").value.trim().toLowerCase();
      const phone = backdrop.querySelector("#co-mobile").value.trim();
      const errEl = backdrop.querySelector("#co-error");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = "कृपया एक सही ईमेल दर्ज करें।"; return; }
      if (!/^[6-9][0-9]{9}$/.test(phone)) { errEl.textContent = "कृपया एक सही 10-अंकों का मोबाइल नंबर दर्ज करें।"; return; }
      try {
        const user = await ensureAnyUser();
        // Best-effort -- a profile write failing here must never block checkout; the same
        // contact info also rides in the order's notes, which the webhook actually relies on.
        setDoc(doc(db, "users", user.uid), { name, email, mobile: phone }, { merge: true }).catch(() => {});
        backdrop.remove();
        resolve({ user, name, email, phone });
      } catch (e) {
        errEl.textContent = friendlyError(e);
      }
    };
  });
}

/** Post-payment "secure your account" prompt for a student who checked out anonymously
 * (see ensureAnyUser). Purely optional from a business standpoint -- access was already
 * granted by the webhook before this ever shows -- it only affects whether they can sign
 * back in on another device later. Never throws; a skip or failure just leaves the
 * anonymous session as the only way in for now. */
function promptSecureAccount(email) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "auth-backdrop";
    document.body.appendChild(backdrop);
    backdrop.innerHTML = `
      <div class="auth-modal">
        <button class="auth-close" aria-label="Close">&times;</button>
        <h2>🎉 भुगतान सफल!</h2>
        <p class="sub">अपना खाता सुरक्षित करें ताकि आप किसी भी डिवाइस से दोबारा साइन इन कर सकें। ${escapeHtml(email)} पर एक कोड भेजा गया है।</p>
        <div class="auth-field"><label>वेरिफिकेशन कोड (6 अंक)</label><input type="text" id="sa-otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>
        <div class="auth-field"><label>पासवर्ड बनाएं (कम से कम 6 अक्षर)</label><input type="password" id="sa-password" minlength="6"></div>
        <div class="auth-error" id="sa-error"></div>
        <button class="btn btn-primary btn-block" id="sa-submit">सत्यापित करें और सुरक्षित करें</button>
        <div class="auth-toggle"><a href="#" id="sa-skip">बाद में करें</a></div>
      </div>`;
    const close = () => { backdrop.remove(); resolve(); };
    backdrop.querySelector(".auth-close").onclick = close;
    backdrop.querySelector("#sa-skip").onclick = (e) => { e.preventDefault(); close(); };
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector("#sa-submit").onclick = async () => {
      const code = backdrop.querySelector("#sa-otp").value.trim();
      const password = backdrop.querySelector("#sa-password").value;
      const errEl = backdrop.querySelector("#sa-error");
      if (password.length < 6) { errEl.textContent = "पासवर्ड कम से कम 6 अक्षरों का होना चाहिए।"; return; }
      try {
        const verifyRes = await fetch(`${CLOUD_FUNCTIONS_BASE_URL}/verify_registration_otp`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code }),
        });
        const verifyBody = await verifyRes.json();
        if (!verifyRes.ok || !verifyBody.verified) throw new Error(verifyBody.error || "कोड सत्यापित नहीं हो सका।");
        await secureAccountWithEmail(email, password);
        close();
      } catch (e) {
        errEl.textContent = e.message?.startsWith("auth/") || e.code ? friendlyError(e) : (e.message || "कुछ गलत हो गया।");
      }
    };
    // Fire the OTP send the moment this modal opens -- the student already proved they own
    // this email once at checkout (they received the order confirmation there), but
    // re-verifying before linking it to a password keeps the same guarantee register.html
    // relies on: nobody can claim an account with an email they don't control.
    fetch(`${CLOUD_FUNCTIONS_BASE_URL}/send_registration_otp`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
    }).catch(() => {});
  });
}

/**
 * Full purchase flow (pay-first, 2026-09-29): a new student is never forced through full
 * registration before reaching payment -- see showCheckoutDetailsModal above and main.py's
 * module docstring. Creates a server-side order (price is looked up server-side from
 * {plan, examSlugs, durationMonths} -- never sent as an amount from here, so a tampered
 * request can't buy at a different price), opens Razorpay Checkout, and on success tells
 * the caller the webhook is processing (entitlement isn't instant -- it lands a few
 * seconds after payment, once the webhook fires) and offers to secure the account.
 *   plan: "single" | "bundle3" | "all_access"
 *   examSlugs: [examSlug] for single, exactly 3 distinct slugs for bundle3, [] for all_access
 */
export async function startPurchase({ plan, examSlugs = [], durationMonths = 12, title }, { onProcessing, onError } = {}) {
  await authReady;
  let user = getCurrentUser();
  let contact = { name: "", email: user?.email || "", phone: "" };

  if (!user || user.isAnonymous) {
    const details = await showCheckoutDetailsModal({ title, prefillEmail: user?.email });
    if (!details) return; // modal closed without completing -- matches showAuthModal's convention
    user = details.user;
    contact = { name: details.name, email: details.email, phone: details.phone };
  }

  try {
    await loadRazorpayScript();
    // The server derives uid from this token -- it never trusts a
    // client-sent uid, which a tampered request could set to a different
    // account than the one actually paying.
    const idToken = await user.getIdToken();
    const orderRes = await fetch(`${CLOUD_FUNCTIONS_BASE_URL}/create_test_series_order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` },
      body: JSON.stringify({
        plan, exam_slugs: examSlugs, duration_months: durationMonths,
        name: contact.name, email: contact.email, phone: contact.phone,
      }),
    });
    if (!orderRes.ok) {
      const body = await orderRes.json().catch(() => ({}));
      throw new Error(body.error || `Order creation failed: ${orderRes.status}`);
    }
    const order = await orderRes.json();

    const rzp = new window.Razorpay({
      key: order.key_id,
      order_id: order.order_id,
      amount: order.amount,
      currency: order.currency,
      name: "RAJ G.K. GURU",
      description: `${title} — ${durationMonths} महीने`,
      prefill: { email: contact.email, contact: contact.phone },
      handler: function () {
        onProcessing?.();
        // Access is already granted by the webhook regardless of what happens below --
        // this is purely about making the account recoverable on another device later.
        if (user.isAnonymous && contact.email) promptSecureAccount(contact.email);
      },
      theme: { color: "#9333ea" },
    });
    rzp.open();
  } catch (e) {
    console.error("Purchase flow failed:", e);
    onError?.(e);
  }
}

/** Compatibility wrapper over startPurchase for existing single-exam "Buy Access" buttons. */
export async function buyAccess(examSlug, examTitle, { durationMonths = 12, onProcessing, onError } = {}) {
  return startPurchase({ plan: "single", examSlugs: [examSlug], durationMonths, title: examTitle }, { onProcessing, onError });
}

/** Resends attempts that could not be saved while offline. Runs on load and whenever the browser comes back online. */
export async function flushPendingAttempts() {
  let q;
  try { q = JSON.parse(localStorage.getItem("pending-attempts") || "[]"); } catch (e) { return; }
  if (!q.length || !navigator.onLine) return;
  await authReady;
  const user = getCurrentUser();
  if (!user) return;
  const left = [];
  for (const item of q) {
    try {
      await addDoc(collection(db, "users", user.uid, "attempts"), { examSlug: item.examSlug, ...item.attempt, timestamp: serverTimestamp() });
    } catch (e) { left.push(item); }
  }
  try { localStorage.setItem("pending-attempts", JSON.stringify(left)); } catch (e) {}
}
window.addEventListener("online", () => flushPendingAttempts());
setTimeout(() => flushPendingAttempts(), 3000);
