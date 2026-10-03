// Firebase Web config for the NEW, isolated GCP project created specifically
// for rajgkguru.aldhruacademy.com (see the isolation principle in
// E:\02_AA_RajasthanGK\DEPLOYMENT.md) -- NOT aldhru-academy-cloud, NOT VMOU's
// project. Firebase Console -> Project settings -> General -> "Your apps" ->
// Web app -> the config object shown there is a plain object, safe to embed
// client-side (it identifies the project, it isn't a secret -- access control
// is enforced by Firestore security rules, not by hiding this object).
//
// Replace every placeholder below once the new project exists. Nothing else
// in shared/auth.js or shared/entitlements.js needs to change.
export const firebaseConfig = {
  apiKey: "AIzaSyDaB9hGbfORoWHRZ1cZdWL_naXjFOYKHiA",
  authDomain: "aldhru-rajgkguru.firebaseapp.com",
  projectId: "aldhru-rajgkguru",
  storageBucket: "aldhru-rajgkguru.firebasestorage.app",
  messagingSenderId: "56158132200",
  appId: "1:56158132200:web:25cd14758e45a26d51365d",
};

// Both Cloud Functions are deployed (asia-south1) and confirmed live --
// verified end-to-end up through Firebase ID token verification. They
// won't actually complete an order yet: RAZORPAY_KEY_ID in
// cloud_functions/test_series/main.py and the razorpay-key-secret /
// razorpay-webhook-secret Secret Manager secrets are still pending real
// Razorpay keys.
export const CLOUD_FUNCTIONS_BASE_URL = "https://asia-south1-aldhru-rajgkguru.cloudfunctions.net";

// cloud_functions/paid_pdf -- a separate Cloud RUN service (not a Cloud Function: WeasyPrint
// needs system libraries a bare Cloud Function doesn't provide), so it has its own URL (deployed,
// asia-south1). Callers still check it is non-empty before showing the "Download PDF" button.
// Paid PDF is deployed (https://paid-pdf-56158132200.asia-south1.run.app) but deliberately switched OFF for launch: empty = button hidden.
export const PAID_PDF_URL = "";
