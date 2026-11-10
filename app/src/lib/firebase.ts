import { initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider, type AppCheck } from "firebase/app-check";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getFunctions, type Functions } from "firebase/functions";

export type BackendMode = "spark" | "functions";

type RuntimeConfig = Partial<FirebaseOptions> & {
  appCheckSiteKey?: string;
  backendMode?: BackendMode;
};

declare global {
  interface Window {
    __FIREBASE_CONFIG__?: RuntimeConfig;
  }
}

const runtimeConfig: RuntimeConfig = window.__FIREBASE_CONFIG__ ?? {};
let savedConfig: RuntimeConfig = {};
try {
  const raw = localStorage.getItem("bakaloriastages.firebaseConfig");
  if (raw) savedConfig = JSON.parse(raw) as RuntimeConfig;
} catch {
  savedConfig = {};
}

const envConfig: RuntimeConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  appCheckSiteKey: import.meta.env.VITE_FIREBASE_APP_CHECK_SITE_KEY,
};

// The deployed config is canonical, then Vite env values, then a value saved
// from the setup screen. Empty strings never shadow a real value.
const pick = (key: keyof RuntimeConfig): string => {
  for (const source of [runtimeConfig, envConfig, savedConfig]) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

export const firebaseConfig: FirebaseOptions = {
  apiKey: pick("apiKey"),
  authDomain: pick("authDomain"),
  projectId: pick("projectId"),
  storageBucket: pick("storageBucket"),
  messagingSenderId: pick("messagingSenderId"),
  appId: pick("appId"),
};

export const appCheckSiteKey = pick("appCheckSiteKey");

// "spark" keeps the whole app on Firebase's free plan: grading and progress
// updates run in the browser against Firestore. "functions" switches back to
// the hardened Cloud Functions backend once the project is on Blaze.
export const backendMode: BackendMode = (() => {
  for (const source of [runtimeConfig, envConfig, savedConfig]) {
    if (source.backendMode === "functions" || source.backendMode === "spark") {
      return source.backendMode;
    }
  }
  return "spark";
})();

export const isSparkMode = backendMode === "spark";

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.authDomain && firebaseConfig.appId,
);

export const app: FirebaseApp | null = isFirebaseConfigured ? initializeApp(firebaseConfig) : null;
export const appCheck: AppCheck | null =
  app && appCheckSiteKey
    ? initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(appCheckSiteKey),
        isTokenAutoRefreshEnabled: true,
      })
    : null;
export const auth: Auth | null = app ? getAuth(app) : null;
export const db: Firestore | null = app ? getFirestore(app) : null;
export const functions: Functions | null = app ? getFunctions(app) : null;

export const STUDENT_EMAIL_DOMAIN = "students.bakaloriarace.app";
