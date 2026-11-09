import { useMemo, useState } from "react";
import { BrandMark } from "../components/Layout";
import { CheckIcon, SparklesIcon } from "../components/Icons";
import { appCheckSiteKey, firebaseConfig } from "../lib/firebase";

const REQUIRED = ["apiKey", "authDomain", "projectId", "appId"] as const;

export function SetupPage() {
  const initial = useMemo(
    () =>
      JSON.stringify(
        {
          apiKey: firebaseConfig.apiKey || "",
          authDomain: firebaseConfig.authDomain || "bakaloriarace.firebaseapp.com",
          projectId: firebaseConfig.projectId || "bakaloriarace",
          storageBucket: firebaseConfig.storageBucket || "bakaloriarace.firebasestorage.app",
          messagingSenderId: firebaseConfig.messagingSenderId || "",
          appId: firebaseConfig.appId || "",
          appCheckSiteKey: appCheckSiteKey || "",
        },
        null,
        2,
      ),
    [],
  );
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");

  function save() {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const missing = REQUIRED.filter((key) => !String(parsed[key] ?? "").trim());
      if (missing.length > 0) {
        setError(`الحقول الناقصة: ${missing.join(", ")}`);
        return;
      }
      localStorage.setItem("bakaloriastages.firebaseConfig", JSON.stringify(parsed));
      window.location.reload();
    } catch {
      setError("صيغة JSON غير صحيحة. تأكد من الأقواس والفواصل.");
    }
  }

  return (
    <div className="setup-page">
      <div className="setup-card">
        <div className="setup-card__brand">
          <BrandMark />
          <div>
            <strong>مراحل البكالوريا</strong>
            <span>إعداد الاتصال بـ Firebase</span>
          </div>
        </div>

        <h1>أضف إعدادات Firebase</h1>
        <p className="muted">
          انسخ كائن <code>firebaseConfig</code> من Firebase Console → Project settings → Your apps،
          ثم الصقه هنا. هذه القيم عامة وليست أسرارًا، لكن لا تضع Service Account أو Private Key.
        </p>

        <label className="field">
          <span>إعدادات Firebase (JSON)</span>
          <textarea
            className="textarea textarea--code"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError("");
            }}
            rows={14}
            spellCheck={false}
            dir="ltr"
          />
        </label>

        {error ? <div className="alert alert--error">{error}</div> : null}

        <button className="button button--primary button--block" type="button" onClick={save}>
          حفظ وإعادة التشغيل
        </button>

        <button
          className="button button--ghost button--block"
          type="button"
          onClick={() => {
            localStorage.removeItem("bakaloriastages.firebaseConfig");
            window.location.reload();
          }}
        >
          مسح الإعدادات المحفوظة
        </button>

        <div className="setup-note">
          <SparklesIcon />
          <p>
            بديل دائم: عدّل الملف <code>app/public/firebase-config.js</code> ثم أعد البناء والنشر.
            الحفظ هنا يخص هذا المتصفح فقط.
          </p>
        </div>

        <ul className="check-list">
          <li><CheckIcon /> Authentication → Email/Password مفعّل.</li>
          <li><CheckIcon /> Firestore Database منشأ.</li>
          <li><CheckIcon /> Cloud Functions منشورة.</li>
        </ul>
      </div>
    </div>
  );
}
