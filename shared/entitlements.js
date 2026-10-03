// Entitlement checks + saved progress (Firestore) + the purchase flow
// (Cloud Functions + Razorpay Checkout.js). All reads/writes go through the
// new isolated project's Firestore -- see firebase-config.js.

import { doc, getDoc, setDoc, deleteDoc, deleteField, arrayUnion, collection, addDoc, getDocs, query, orderBy, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { db, getCurrentUser, showAuthModal, authReady, ensureAnyUser, finalizeCheckoutAccount, showChangePasswordModal, friendlyError } from "./auth.js?v=6";
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

async function fetchPaidPoolUncached(examSlug, retried = false) {
  await authReady;
  const user = getCurrentUser();
  if (!user) throw new Error("Not signed in");
  const idToken = await user.getIdToken(retried);
  const res = await fetch(`${CLOUD_FUNCTIONS_BASE_URL}/get_paid_pool?exam_slug=${encodeURIComponent(examSlug)}`, {
    headers: { "Authorization": `Bearer ${idToken}`, "X-Device-Id": getDeviceId() },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Token still carries the checkout "must change password" flag (e.g. the password was just
    // changed on another device): fetch a fresh token once and retry before giving up.
    if (body.code === "password_change_required" && !retried) return fetchPaidPoolUncached(examSlug, true);
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
        if (user.isAnonymous) {
          // A guest session can never be merged into an account that already uses this email
          // (the post-payment "secure account" step would fail and strand the purchase), so
          // make them sign in to that account BEFORE paying.
          let exists;
          try {
            const res = await fetch(`${CLOUD_FUNCTIONS_BASE_URL}/check_email_account`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${await user.getIdToken()}` },
              body: JSON.stringify({ email }),
            });
            if (!res.ok) throw new Error(String(res.status));
            exists = (await res.json()).exists;
          } catch (e) {
            errEl.textContent = "ईमेल जाँचने में समस्या हुई — कृपया दोबारा कोशिश करें।";
            return;
          }
          if (exists) {
            backdrop.remove();
            const signedIn = await showAuthModal({ prefillEmail: email, reason: "इस ईमेल से आपका खाता पहले से है — भुगतान से पहले साइन इन करें, ताकि खरीदा हुआ एक्सेस इसी खाते में जुड़े।" });
            if (signedIn) resolve({ user: signedIn, name, email, phone });
            return;
          }
        }
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

/** Post-payment account creation for a student who checked out as a guest (see ensureAnyUser).
 * Access was already granted by the webhook, so this only decides whether they can sign back
 * in later. One step for the student: type the emailed OTP. The server then creates the
 * account (login ID = email, starting password = the mobile number given at checkout) and the
 * site makes them choose their own password (shared/auth.js, must_change_password). Never
 * throws; skipping just leaves the guest session as the only way in on this device. */
function promptSecureAccount(email, phone) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "auth-backdrop";
    document.body.appendChild(backdrop);
    backdrop.innerHTML = `
      <div class="auth-modal">
        <button class="auth-close" aria-label="Close">&times;</button>
        <h2>🎉 भुगतान सफल!</h2>
        <p class="sub">अपना खाता बनाएं ताकि किसी भी डिवाइस से साइन इन कर सकें। ${escapeHtml(email)} पर एक 6-अंकों का कोड भेजा गया है।</p>
        <div class="auth-field"><label>वेरिफिकेशन कोड (6 अंक)</label><input type="text" id="sa-otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>
        <div class="auth-error" id="sa-error"></div>
        <button class="btn btn-primary btn-block" id="sa-submit">सत्यापित करें और खाता बनाएं</button>
        <div class="auth-toggle"><a href="#" id="sa-resend">कोड दोबारा भेजें</a> &nbsp;·&nbsp; <a href="#" id="sa-skip">बाद में करें</a></div>
      </div>`;
    const close = () => { backdrop.remove(); resolve(); };
    backdrop.querySelector(".auth-close").onclick = close;
    backdrop.querySelector("#sa-skip").onclick = (e) => { e.preventDefault(); close(); };
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector("#sa-submit").onclick = async () => {
      const code = backdrop.querySelector("#sa-otp").value.trim();
      const errEl = backdrop.querySelector("#sa-error");
      const btn = backdrop.querySelector("#sa-submit");
      if (!/^[0-9]{6}$/.test(code)) { errEl.textContent = "6 अंकों का कोड दर्ज करें।"; return; }
      btn.disabled = true; errEl.textContent = "";
      try {
        await finalizeCheckoutAccount(email, code, phone);
        // The account now exists with the mobile number as its starting password. Make the
        // student choose their own password RIGHT NOW (shared/auth.js raised this same
        // box when the sign-in happened; we wait on it) so the weak password lives seconds.
        backdrop.style.display = "none";
        const changed = await showChangePasswordModal({ forced: true });
        backdrop.style.display = "";
        backdrop.querySelector(".auth-modal").innerHTML = `
          <h2>✅ आपका खाता तैयार है</h2>
          <p class="sub">अगली बार साइन इन के लिए:</p>
          <p style="margin:8px 0"><b>Login ID:</b> ${escapeHtml(email)}<br><b>पासवर्ड:</b> ${changed ? "जो आपने अभी बनाया" : "आपका मोबाइल नंबर (साइन इन करते ही नया पासवर्ड चुनना होगा)"}</p>
          <button class="btn btn-primary btn-block" id="sa-ok">ठीक है</button>`;
        backdrop.querySelector("#sa-ok").onclick = close;
      } catch (e) {
        btn.disabled = false;
        errEl.textContent = e.message || "कुछ गलत हो गया।";
      }
    };
    // Send the OTP the moment this modal opens -- and say so if it could not be sent.
    const sendOtp = async () => {
      const errEl = backdrop.querySelector("#sa-error");
      try {
        const r = await fetch(`${CLOUD_FUNCTIONS_BASE_URL}/send_registration_otp`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
        });
        const b = await r.json().catch(() => ({}));
        errEl.textContent = r.ok ? "" : (b.error || "कोड नहीं भेजा जा सका — थोड़ी देर बाद 'कोड दोबारा भेजें' दबाएं।");
      } catch (e) {
        errEl.textContent = "इंटरनेट की समस्या — 'कोड दोबारा भेजें' दबाएं।";
      }
    };
    backdrop.querySelector("#sa-resend").onclick = (e) => { e.preventDefault(); sendOtp(); };
    sendOtp();
  });
}

/** For a guest (anonymous) session: lets them finish making a real account later -- from the
 * header's "खाता सुरक्षित करें" button -- if they skipped the post-payment step or the code
 * never arrived. Email and mobile are prefilled from what they entered at checkout. */
export async function openSecureAccountFlow() {
  await authReady;
  const user = getCurrentUser();
  if (!user || !user.isAnonymous) return;
  let saved = {};
  try { saved = (await getDoc(doc(db, "users", user.uid))).data() || {}; } catch (e) {}
  const backdrop = document.createElement("div");
  backdrop.className = "auth-backdrop";
  document.body.appendChild(backdrop);
  backdrop.innerHTML = `
    <div class="auth-modal">
      <button class="auth-close" aria-label="Close">&times;</button>
      <h2>खाता सुरक्षित करें</h2>
      <p class="sub">ताकि आप किसी भी डिवाइस से साइन इन कर सकें और आपका खरीदा हुआ एक्सेस सुरक्षित रहे।</p>
      <div class="auth-field"><label>ईमेल</label><input type="email" id="sg-email" autocomplete="email" value="${escapeHtml(saved.email || "")}"></div>
      <div class="auth-field"><label>मोबाइल नंबर</label><input type="tel" id="sg-mobile" maxlength="10" autocomplete="tel" value="${escapeHtml(saved.mobile || "")}"></div>
      <div class="auth-error" id="sg-error"></div>
      <button class="btn btn-primary btn-block" id="sg-go">कोड भेजें</button>
    </div>`;
  backdrop.querySelector(".auth-close").onclick = () => backdrop.remove();
  backdrop.querySelector("#sg-go").onclick = async () => {
    const email = backdrop.querySelector("#sg-email").value.trim().toLowerCase();
    const phone = backdrop.querySelector("#sg-mobile").value.trim();
    const errEl = backdrop.querySelector("#sg-error");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = "कृपया एक सही ईमेल दर्ज करें।"; return; }
    if (!/^[6-9][0-9]{9}$/.test(phone)) { errEl.textContent = "कृपया एक सही 10-अंकों का मोबाइल नंबर दर्ज करें।"; return; }
    try {
      const res = await fetch(`${CLOUD_FUNCTIONS_BASE_URL}/check_email_account`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${await user.getIdToken()}` },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(String(res.status));
      if ((await res.json()).exists) {
        errEl.textContent = "इस ईमेल से खाता पहले से है। उस खाते में साइन इन करें — आपका खरीदा हुआ एक्सेस वहीं जोड़ने के लिए हमें support@aldhruacademy.com पर लिखें।";
        return;
      }
    } catch (e) { errEl.textContent = "ईमेल जाँचने में समस्या हुई — दोबारा कोशिश करें।"; return; }
    backdrop.remove();
    await promptSecureAccount(email, phone);
    if (!getCurrentUser()?.isAnonymous) location.reload();
  };
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
      handler: async function (response) {
        onProcessing?.();
        // Ask our server to verify the payment signature and unlock access right now, so the
        // purchase doesn't depend on the webhook alone (the webhook stays as the backup and the
        // two can't double-grant: both go through one idempotent fulfilment).
        let unlocked = false;
        for (let attempt = 0; attempt < 4 && !unlocked; attempt++) {
          try {
            const vr = await fetch(`${CLOUD_FUNCTIONS_BASE_URL}/verify_test_series_payment`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${await user.getIdToken()}` },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });
            if (vr.ok) unlocked = true;
            else if (vr.status === 202 || vr.status >= 500) await new Promise((r) => setTimeout(r, 2500));
            else break;   // a definite refusal (bad signature / other account): retrying won't help
          } catch (e) { await new Promise((r) => setTimeout(r, 2500)); }
        }
        // Make the account recoverable on another device (optional for the student).
        if (user.isAnonymous && contact.email) await promptSecureAccount(contact.email, contact.phone);
        if (unlocked) location.reload();
        else alert("आपका भुगतान मिल गया है। एक्सेस जुड़ने में कुछ मिनट लग सकते हैं — कृपया थोड़ी देर बाद पेज रीफ़्रेश करें। समस्या रहे तो " + "support@aldhruacademy.com" + " पर लिखें।");
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
