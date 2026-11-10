import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { BrandMark } from "../components/Layout";
import { FullScreenLoader } from "../components/Loading";
import {
  ArrowLeftIcon,
  BookIcon,
  CheckIcon,
  SparklesIcon,
  TrophyIcon,
} from "../components/Icons";
import { useAuth } from "../context/AuthContext";
import { errorMessage } from "../lib/errors";
import type { Branch } from "../lib/types";

type Mode = "login" | "register";

export function LoginPage() {
  const { user, profile, loading, registering, login, register, logout } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [branch, setBranch] = useState<Branch>("scientific");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (loading) return <FullScreenLoader label="نفتح لك مراحل البكالوريا..." />;
  if (user && !profile && registering) {
    return <FullScreenLoader label="نجهّز حسابك..." />;
  }
  if (user && profile) return <Navigate to="/" replace />;
  if (user && !profile) {
    return (
      <div className="full-screen-loader">
        <div className="empty-state">
          <h3>تعذر تحميل ملف الطالب</h3>
          <p>الحساب موجود لكن ملفه غير مكتمل. سجّل الخروج ثم حاول مرة أخرى.</p>
          <button className="button button--primary" type="button" onClick={() => void logout()}>
            تسجيل الخروج
          </button>
        </div>
      </div>
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "login") {
        await login(username, password);
      } else {
        await register({ username, password, displayName, branch });
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <section className="auth-hero">
        <div className="auth-hero__glow" aria-hidden="true" />
        <div className="auth-brand">
          <BrandMark />
          <span>مراحل البكالوريا</span>
        </div>

        <div className="auth-hero__content">
          <span className="eyebrow">
            <SparklesIcon />
            مسابقة تراكمية للبكالوريا
          </span>
          <h1>كل سؤال يقرّبك من الإتقان.</h1>
          <p>
            اختر مادتك، تدرّب على أسئلة الدرس الأول، ثم تعود إليها في مراجعة متباعدة.
            لا سؤال يُنسى، والإجابة النموذجية أمامك بعد كل مرحلة.
          </p>

          <div className="auth-features">
            <div className="auth-feature">
              <BookIcon />
              <div>
                <strong>كل أسئلة المادة</strong>
                <span>تغطية كاملة، دون تخطي سؤال.</span>
              </div>
            </div>
            <div className="auth-feature">
              <TrophyIcon />
              <div>
                <strong>مراحل وجلسات</strong>
                <span>5 أسئلة في المرحلة، وفاصل بين الجلسات.</span>
              </div>
            </div>
            <div className="auth-feature">
              <CheckIcon />
              <div>
                <strong>إجابة نموذجية</strong>
                <span>تظهر بعد التسليم للحفظ والمراجعة.</span>
              </div>
            </div>
          </div>
        </div>

        <div className="auth-hero__footer">
          <span>علمي وأدبي</span>
          <span className="dot" />
          <span>مراجعة متباعدة</span>
          <span className="dot" />
          <span>شهادة إتمام</span>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-tabs" role="tablist" aria-label="دخول أو إنشاء حساب">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "login"}
              className={mode === "login" ? "is-active" : ""}
              onClick={() => {
                setMode("login");
                setError("");
              }}
            >
              تسجيل الدخول
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              className={mode === "register" ? "is-active" : ""}
              onClick={() => {
                setMode("register");
                setError("");
              }}
            >
              حساب جديد
            </button>
          </div>

          <div className="auth-card__heading">
            <h2>{mode === "login" ? "أهلًا بعودتك" : "ابدأ رحلتك"}</h2>
            <p>
              {mode === "login"
                ? "أكمل من حيث توقفت، المرحلة القادمة تنتظرك."
                : "أنشئ حسابك واختر فرعك، ثم انضم إلى موادك."}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="form">
            <label className="field">
              <span>اسم المستخدم</span>
              <input
                className="input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="مثال: ahmed_2026"
                autoComplete="username"
                dir="ltr"
                required
                minLength={3}
                maxLength={20}
                pattern="[A-Za-z0-9_]{3,20}"
              />
              {mode === "register" ? (
                <small>3–20 حرفًا إنجليزيًا أو أرقامًا أو _</small>
              ) : null}
            </label>

            {mode === "register" ? (
              <>
                <label className="field">
                  <span>الاسم الذي يظهر في الترتيب</span>
                  <input
                    className="input"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="مثال: أحمد"
                    maxLength={40}
                    required
                  />
                </label>

                <fieldset className="field">
                  <legend>الفرع الدراسي</legend>
                  <div className="branch-choice">
                    <label className={branch === "scientific" ? "is-selected" : ""}>
                      <input
                        type="radio"
                        name="branch"
                        value="scientific"
                        checked={branch === "scientific"}
                        onChange={() => setBranch("scientific")}
                      />
                      <span className="branch-choice__icon">⚗️</span>
                      <span>
                        <strong>علمي</strong>
                        <small>رياضيات، فيزياء، علوم…</small>
                      </span>
                    </label>
                    <label className={branch === "literary" ? "is-selected" : ""}>
                      <input
                        type="radio"
                        name="branch"
                        value="literary"
                        checked={branch === "literary"}
                        onChange={() => setBranch("literary")}
                      />
                      <span className="branch-choice__icon">📜</span>
                      <span>
                        <strong>أدبي</strong>
                        <small>تاريخ، جغرافيا، فلسفة…</small>
                      </span>
                    </label>
                  </div>
                </fieldset>
              </>
            ) : null}

            <label className="field">
              <span>كلمة المرور</span>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="6 أحرف على الأقل"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={6}
                required
              />
            </label>

            {error ? <div className="alert alert--error">{error}</div> : null}

            <button className="button button--primary button--block button--lg" type="submit" disabled={busy}>
              {busy ? (
                "لحظة..."
              ) : (
                <>
                  {mode === "login" ? "ادخل إلى مراحلي" : "أنشئ الحساب وابدأ"}
                  <ArrowLeftIcon />
                </>
              )}
            </button>
          </form>

          <p className="auth-footnote">
            {mode === "login" ? (
              <>
                ليس لديك حساب؟{" "}
                <button type="button" className="link-button" onClick={() => setMode("register")}>
                  أنشئ حسابًا
                </button>
              </>
            ) : (
              <>
                لديك حساب بالفعل؟{" "}
                <button type="button" className="link-button" onClick={() => setMode("login")}>
                  سجّل الدخول
                </button>
              </>
            )}
          </p>
        </div>
      </section>
    </div>
  );
}
