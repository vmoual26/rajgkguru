// Firebase Auth (email/password) + a minimal sign-in modal, shared by the
// homepage and every exam page. Account CREATION always goes through
// register.html's mandatory email-OTP flow, never through this module.
// Loaded as an ES module (<script type="module">), talks only to the new
// isolated project named in firebase-config.js.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  signInAnonymously, linkWithCredential, EmailAuthProvider, updatePassword,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig, CLOUD_FUNCTIONS_BASE_URL } from "./firebase-config.js?v=2";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Firebase restores a signed-in session asynchronously -- auth.currentUser
// is null until the first onAuthStateChanged fires, even for a returning
// signed-in user. Anything that reads getCurrentUser() synchronously right
// after page load (checkEntitlement, buyAccess) must await this first, or
// it will wrongly treat a signed-in user as signed out.
let resolveAuthReady;
export const authReady = new Promise((resolve) => { resolveAuthReady = resolve; });
onAuthStateChanged(auth, (user) => {
  if (resolveAuthReady) { resolveAuthReady(user); resolveAuthReady = null; }
});

export function getCurrentUser() {
  return auth.currentUser;
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

export function signOutUser() {
  return signOut(auth);
}

/** Pay-first checkout (2026-09-29, see main.py's module docstring for the full flow):
 * returns the current user if any exists (a real account OR a still-anonymous one from an
 * earlier, abandoned attempt), otherwise silently creates a Firebase ANONYMOUS user --
 * no password, no screen, resolves in under a second. This is what lets a brand-new
 * student reach the payment screen without first completing full registration; the uid
 * this returns is what the order (and later the entitlement) is tied to. */
export async function ensureAnyUser() {
  await authReady;
  const existing = getCurrentUser();
  if (existing) return existing;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

/** Upgrades the CURRENTLY signed-in anonymous user (from ensureAnyUser) to a permanent
 * email+password account, keeping the same uid -- so purchases already granted to that
 * uid stay attached, no data migration needed. Call only after the email has been
 * verified via send_registration_otp/verify_registration_otp, same as register.html.
 * Throws auth/email-already-in-use if that email already has a real account elsewhere --
 * callers should catch this and offer "sign in instead" rather than treat it as a bug. */
export async function secureAccountWithEmail(email, password) {
  const user = getCurrentUser();
  if (!user) throw new Error("No active session to secure");
  const credential = EmailAuthProvider.credential(email, password);
  const result = await linkWithCredential(user, credential);
  return result.user;
}

/** Post-payment account creation for a guest buyer: the server checks the emailed OTP, makes
 * the guest uid a real email+password account (starting password = the mobile number given at
 * checkout) and flags it must_change_password. We then sign in with those credentials so the
 * fresh token carries the flag. Throws Error(message) with a student-readable message. */
export async function finalizeCheckoutAccount(email, code, phone) {
  const user = getCurrentUser();
  if (!user) throw new Error("साइन इन सत्र नहीं मिला — पेज रीफ्रेश करें।");
  const res = await fetch(`${CLOUD_FUNCTIONS_BASE_URL}/finalize_checkout_account`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${await user.getIdToken()}` },
    body: JSON.stringify({ email, code, phone }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "खाता नहीं बन सका।");
  const cred = await signInWithEmailAndPassword(auth, email, phone);
  return cred.user;
}

/** New-password rules (client side; Firebase itself only demands 6 characters). */
export function passwordPolicyError(pw, email) {
  if (pw.length < 8) return "पासवर्ड कम से कम 8 अक्षरों का होना चाहिए।";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "पासवर्ड में अक्षर और अंक दोनों होने चाहिए।";
  if (/^[0-9]{10}$/.test(pw)) return "मोबाइल नंबर जैसा पासवर्ड न रखें — कोई नया पासवर्ड चुनें।";
  if (email && pw.toLowerCase() === String(email).toLowerCase()) return "पासवर्ड ईमेल जैसा नहीं होना चाहिए।";
  return "";
}

let changePwPromise = null;
/** Set-your-own-password modal. forced=true: no close button, no dismiss -- shown when the
 * account still has its starting (mobile-number) password. */
export function showChangePasswordModal({ forced = false } = {}) {
  if (changePwPromise) return changePwPromise;   // already open (e.g. raised by the auth observer): share it
  const user = getCurrentUser();
  if (!user) return Promise.resolve(false);
  changePwPromise = new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "auth-backdrop";
    backdrop.style.zIndex = "99999";
    document.body.appendChild(backdrop);
    backdrop.innerHTML = `
      <div class="auth-modal">
        ${forced ? "" : '<button class="auth-close" aria-label="Close">&times;</button>'}
        <h2>🔒 नया पासवर्ड बनाएं</h2>
        <p class="sub">${forced ? "सुरक्षा के लिए अपना शुरुआती पासवर्ड (मोबाइल नंबर) बदलें। यह एक बार का काम है।" : "अपना पासवर्ड बदलें।"}</p>
        <div class="auth-field"><label>नया पासवर्ड (कम से कम 8 अक्षर, अक्षर + अंक)</label><input type="password" id="cp-new" autocomplete="new-password"></div>
        <div class="auth-field"><label>पासवर्ड दोबारा लिखें</label><input type="password" id="cp-new2" autocomplete="new-password"></div>
        <div class="auth-error" id="cp-error"></div>
        <button class="btn btn-primary btn-block" id="cp-submit">पासवर्ड सेव करें</button>
        ${forced ? '<div class="auth-toggle"><a href="#" id="cp-signout">Sign out</a></div>' : ""}
      </div>`;
    const done = (ok) => { backdrop.remove(); changePwPromise = null; resolve(ok); };
    backdrop.querySelector(".auth-close")?.addEventListener("click", () => done(false));
    backdrop.querySelector("#cp-signout")?.addEventListener("click", async (e) => { e.preventDefault(); await signOutUser(); done(false); });
    backdrop.querySelector("#cp-submit").onclick = async () => {
      const pw = backdrop.querySelector("#cp-new").value;
      const pw2 = backdrop.querySelector("#cp-new2").value;
      const errEl = backdrop.querySelector("#cp-error");
      errEl.textContent = "";
      const bad = passwordPolicyError(pw, user.email);
      if (bad) { errEl.textContent = bad; return; }
      if (pw !== pw2) { errEl.textContent = "दोनों पासवर्ड एक जैसे नहीं हैं।"; return; }
      try {
        await updatePassword(user, pw);
        // The server refuses paid content while the flag is set, so make sure it is cleared
        // (retrying is safe: re-setting the same new password is harmless).
        const clr = await fetch(`${CLOUD_FUNCTIONS_BASE_URL}/clear_must_change_password`, {
          method: "POST", headers: { "Authorization": `Bearer ${await user.getIdToken()}` },
        });
        if (!clr.ok) throw new Error("clear-failed");
        await user.getIdToken(true);
        done(true);
      } catch (e) {
        if (e?.code === "auth/requires-recent-login") {
          await signOutUser(); done(false);
          showAuthModal({ reason: "सुरक्षा के लिए एक बार दोबारा साइन इन करें, फिर पासवर्ड बदलें।" });
        } else {
          errEl.textContent = e?.message === "clear-failed" || e instanceof TypeError
            ? "पासवर्ड सेव हो गया, लेकिन पुष्टि नहीं हो सकी — इंटरनेट जाँचकर फिर से 'सेव करें' दबाएं।"
            : friendlyError(e);
        }
      }
    };
  });
  return changePwPromise;
}

// Accounts created at checkout start with the mobile number as the password; the server flags
// them with the must_change_password claim (no Firestore read needed -- it rides in the token).
onAuthStateChanged(auth, async (user) => {
  if (!user || user.isAnonymous) return;
  try {
    const { claims } = await user.getIdTokenResult();
    if (claims.must_change_password) showChangePasswordModal({ forced: true });
  } catch (e) { /* offline: try again on the next page load */ }
});

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const FRIENDLY_ERRORS = {
  "auth/email-already-in-use": "यह ईमेल पहले से रजिस्टर्ड है — Sign in करें।",
  "auth/credential-already-in-use": "यह ईमेल पहले से किसी और खाते से जुड़ा है — Sign in करें।",
  "auth/invalid-email": "कृपया एक सही ईमेल दर्ज करें।",
  "auth/weak-password": "पासवर्ड कम से कम 6 अक्षरों का होना चाहिए।",
  "auth/requires-recent-login": "सुरक्षा के लिए दोबारा साइन इन करें।",
  "auth/invalid-credential": "ईमेल या पासवर्ड गलत है।",
  "auth/too-many-requests": "बहुत सारे प्रयास — कृपया कुछ देर बाद कोशिश करें।",
};

export function friendlyError(err) {
  return FRIENDLY_ERRORS[err?.code] || "कुछ गलत हो गया, दोबारा कोशिश करें।";
}

/**
 * Shows a sign-in-only modal. Resolves with the signed-in user once
 * successful; the returned promise never rejects on cancel -- it simply
 * never resolves (caller's flow just stops there), matching how a "Buy
 * Access" click should behave if the student closes the modal.
 *
 * Deliberately sign-in only, no in-modal account creation: registration
 * must always go through register.html's mandatory email-OTP verification.
 * An earlier version of this modal had its own "खाता बनाएं" mode that called
 * createUserWithEmailAndPassword() directly -- a real gap that bypassed OTP
 * verification entirely. The "खाता नहीं है?" link below goes to
 * register.html instead of toggling an in-modal form.
 */
export function showAuthModal({ reason, prefillEmail } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "auth-backdrop";
    document.body.appendChild(backdrop);

    backdrop.innerHTML = `
      <div class="auth-modal">
        <button class="auth-close" aria-label="Close">&times;</button>
        <h2>साइन इन करें</h2>
        <p class="sub">${escapeHtml(reason || "जारी रखने के लिए साइन इन करें।")}</p>
        <div class="auth-field">
          <label>ईमेल</label>
          <input type="email" id="auth-email" autocomplete="email" value="${escapeHtml(prefillEmail || "")}">
        </div>
        <div class="auth-field">
          <label>पासवर्ड</label>
          <input type="password" id="auth-password" autocomplete="current-password">
        </div>
        <div class="auth-error" id="auth-error"></div>
        <button class="btn btn-primary btn-block" id="auth-submit">साइन इन करें</button>
        <div class="auth-toggle">
          खाता नहीं है? <a href="/register.html">खाता बनाएं</a>
        </div>
      </div>`;

    backdrop.querySelector(".auth-close").onclick = () => backdrop.remove();
    backdrop.querySelector("#auth-submit").onclick = submit;
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

    async function submit() {
      const email = backdrop.querySelector("#auth-email").value.trim();
      const password = backdrop.querySelector("#auth-password").value;
      const errEl = backdrop.querySelector("#auth-error");
      errEl.textContent = "";
      try {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        backdrop.remove();
        resolve(cred.user);
      } catch (err) {
        errEl.textContent = friendlyError(err);
      }
    }
  });
}

/** Small "Hi, x@y.com [Sign out]" badge, or a Register + Sign in pair if
 * logged out. This is the ONE place these show -- call once per page (via
 * shared/chrome.js's header) rather than also adding a separate CTA
 * elsewhere, or a signed-out visitor sees two sign-in entry points at once. */
export function renderAuthBadge(container) {
  function update(user) {
    if (user) {
      if (user.isAnonymous) {
        // A guest (paid or tried to pay without making an account): the way back to a real login.
        container.innerHTML = `<div class="user-badge"><span>Guest</span><button id="auth-secure">खाता सुरक्षित करें</button></div>`;
        container.querySelector("#auth-secure").onclick = () =>
          import("./entitlements.js?v=10").then((m) => m.openSecureAccountFlow()).catch(() => {});
        return;
      }
      container.innerHTML = `<div class="user-badge"><span>${escapeHtml(user.email)}</span><button id="auth-signout">Sign out</button></div>`;
      container.querySelector("#auth-signout").onclick = () => signOutUser();
    } else {
      container.innerHTML = `
        <div class="auth-cta-pair">
          <a href="/register.html" class="btn btn-secondary">रजिस्टर करें</a>
          <button class="btn btn-primary" id="auth-signin-btn">साइन इन करें</button>
        </div>`;
      container.querySelector("#auth-signin-btn").onclick = () => showAuthModal({});
    }
  }
  onAuthChange(update);
}
