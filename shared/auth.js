// Firebase Auth (email/password) + a minimal sign-in modal, shared by the
// homepage and every exam page. Account CREATION always goes through
// register.html's mandatory email-OTP flow, never through this module.
// Loaded as an ES module (<script type="module">), talks only to the new
// isolated project named in firebase-config.js.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  signInAnonymously, linkWithCredential, EmailAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js?v=2";

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
