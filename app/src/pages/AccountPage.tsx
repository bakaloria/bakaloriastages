import { Link } from "react-router-dom";
import { BrandMark } from "../components/Layout";
import {
  BookIcon,
  CheckIcon,
  LogoutIcon,
  SparklesIcon,
  TrophyIcon,
  UserIcon,
} from "../components/Icons";
import { useAuth } from "../context/AuthContext";
import { branchLabel } from "../lib/format";

export function AccountPage() {
  const { profile, logout, settings } = useAuth();

  return (
    <div className="page account-page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">
            <UserIcon />
            حسابي
          </span>
          <h1>ملف الطالب</h1>
          <p>بيانات حسابك وفرعك الدراسي، ومن هنا يمكنك تسجيل الخروج.</p>
        </div>
      </section>

      <section className="account-card">
        <div className="account-card__profile">
          <span className="account-avatar">{(profile?.displayName || "ط").slice(0, 1)}</span>
          <div>
            <h2>{profile?.displayName}</h2>
            <span className="muted" dir="ltr">@{profile?.username}</span>
            <div className="account-badges">
              <span className="badge badge--green">{branchLabel(profile?.branch)}</span>
              <span className="badge badge--soft">
                {profile?.role === "admin" ? "مشرف" : "طالب"}
              </span>
            </div>
          </div>
        </div>

        <div className="account-details">
          <div>
            <span>اسم المستخدم</span>
            <strong dir="ltr">{profile?.username}</strong>
          </div>
          <div>
            <span>الاسم الظاهر</span>
            <strong>{profile?.displayName}</strong>
          </div>
          <div>
            <span>الفرع</span>
            <strong>{branchLabel(profile?.branch)}</strong>
          </div>
          <div>
            <span>نوع الحساب</span>
            <strong>{profile?.role === "admin" ? "مشرف" : "طالب"}</strong>
          </div>
        </div>

        <div className="account-actions">
          <Link to="/progress" className="button button--primary">
            <BookIcon />
            عرض تقدمي
          </Link>
          <Link to="/leaderboard" className="button button--ghost">
            <TrophyIcon />
            المتصدرون
          </Link>
          <button className="button button--danger-ghost" type="button" onClick={() => void logout()}>
            <LogoutIcon />
            تسجيل الخروج
          </button>
        </div>
      </section>

      <section className="account-info-grid">
        <article className="info-card">
          <div className="info-card__icon"><BrandMark /></div>
          <h3>ثبّت التطبيق</h3>
          <p>
            من متصفح الهاتف، افتح قائمة المتصفح واختر «إضافة إلى الشاشة الرئيسية» ليعمل
            التطبيق كتطبيق مستقل.
          </p>
        </article>

        <article className="info-card">
          <div className="info-card__icon"><SparklesIcon /></div>
          <h3>كيف تتقدم؟</h3>
          <ul className="plain-list">
            <li><CheckIcon /> كل مرحلة تضيف أسئلة جديدة وتراجع أسئلة سابقة.</li>
            <li><CheckIcon /> بعد التسليم تظهر الإجابة النموذجية.</li>
            <li>
              <CheckIcon />{" "}
              {settings.certificateClaimsEnabled
                ? "أكمل التغطية والإتقان لعرض الشهادة."
                : "أكمل التغطية والإتقان استعدادًا لامتحان الشهادة."}
            </li>
            {settings.finalExamReminder ? (
              <li><CheckIcon /> {settings.finalExamReminder}</li>
            ) : null}
          </ul>
        </article>
      </section>
    </div>
  );
}
