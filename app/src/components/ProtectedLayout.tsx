import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Layout } from "./Layout";
import { FullScreenLoader } from "./Loading";

function ProfileIssue({ onLogout }: { onLogout: () => Promise<void> }) {
  return (
    <div className="full-screen-loader">
      <div className="empty-state">
        <h3>تعذر تحميل ملف الطالب</h3>
        <p>الحساب موجود لكن ملفه غير مكتمل. سجّل الخروج ثم حاول مرة أخرى.</p>
        <button className="button button--primary" type="button" onClick={() => void onLogout()}>
          تسجيل الخروج
        </button>
      </div>
    </div>
  );
}

export function ProtectedLayout() {
  const { loading, user, profile, logout } = useAuth();

  if (loading) return <FullScreenLoader label="نفتح لك مراحل البكالوريا..." />;
  if (!user) return <Navigate to="/login" replace />;
  if (!profile) return <ProfileIssue onLogout={logout} />;
  return <Layout />;
}
