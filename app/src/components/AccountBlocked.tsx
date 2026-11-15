import { LockIcon } from "./Icons";

interface AccountBlockedProps {
  variant: "disabled" | "deleted";
  reason?: string;
  onLogout: () => Promise<void>;
}

export function AccountBlocked({ variant, reason, onLogout }: AccountBlockedProps) {
  const deleted = variant === "deleted";
  return (
    <div className="full-screen-loader">
      <div className="empty-state">
        <span className="eyebrow">
          <LockIcon />
          {deleted ? "الحساب محذوف" : "الحساب معطّل"}
        </span>
        <h3>{deleted ? "تم حذف هذا الحساب من التطبيق" : "تم إيقاف هذا الحساب مؤقتًا"}</h3>
        <p>
          {deleted
            ? "لم يعد هذا الحساب قادرًا على الدخول إلى التطبيق. إذا كنت تعتقد أن الحذف حدث بالخطأ، تواصل مع إدارة المنصة لاستعادته."
            : "أوقفت الإدارة هذا الحساب، ولن تتمكن من استخدام التطبيق حتى يُعاد تفعيله. تواصل مع إدارة المنصة للمزيد."}
        </p>
        {reason ? <p className="muted small">السبب: {reason}</p> : null}
        <button className="button button--primary" type="button" onClick={() => void onLogout()}>
          تسجيل الخروج
        </button>
      </div>
    </div>
  );
}
