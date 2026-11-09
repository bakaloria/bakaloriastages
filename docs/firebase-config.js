/*
  Firebase Web Config.
  هذه القيم عامة بطبيعتها (ليست أسرارًا)، لكن لا تضع هنا أي Service Account
  أو Private Key. املأ apiKey و appId و messagingSenderId من Firebase Console
  ثم أعد نشر الموقع.
*/
window.__FIREBASE_CONFIG__ = {
  apiKey: "",
  authDomain: "bakaloriarace.firebaseapp.com",
  projectId: "bakaloriarace",
  storageBucket: "bakaloriarace.firebasestorage.app",
  messagingSenderId: "",
  appId: "",
  // اختياري: مفتاح reCAPTCHA v3 من Firebase App Check.
  // اتركه فارغًا حتى تُسجّل تطبيق الويب وتفعّل App Check.
  appCheckSiteKey: ""
};
