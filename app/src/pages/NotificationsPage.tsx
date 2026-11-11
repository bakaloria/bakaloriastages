import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";
import { BellIcon, MegaphoneIcon, RefreshIcon } from "../components/Icons";
import { InlineLoader } from "../components/Loading";
import {
  announcementClasses,
  fetchActiveAnnouncements,
  markAnnouncementsSeen,
} from "../lib/announcements";
import { errorMessage } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import type { Announcement } from "../lib/types";

const TONE_LABELS: Record<Announcement["tone"], string> = {
  info: "إعلان",
  success: "خبر سار",
  warning: "تنبيه",
  danger: "هام",
};

export function NotificationsPage() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const rows = await fetchActiveAnnouncements();
      setAnnouncements(rows);
      markAnnouncementsSeen(rows.map((row) => row.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="page notifications-page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">
            <BellIcon />
            مركز الإشعارات
          </span>
          <h1>رسائل الإدارة والإعلانات</h1>
          <p>تابع هنا كل ما تنشره إدارة المنصة من تنبيهات ومواعيد ومستجدات.</p>
        </div>
        <button className="button button--ghost" type="button" onClick={() => void load()}>
          <RefreshIcon />
          تحديث
        </button>
      </section>

      {error ? <div className="alert alert--error">{error}</div> : null}

      {loading ? (
        <InlineLoader label="نجلب الإشعارات..." />
      ) : announcements.length === 0 ? (
        <EmptyState
          title="لا توجد إشعارات حاليًا"
          description="ستظهر هنا رسائل الإدارة والإعلانات الجديدة فور نشرها."
          icon={<MegaphoneIcon />}
          action={
            <Link to="/" className="button button--primary">
              العودة للرئيسية
            </Link>
          }
        />
      ) : (
        <div className="notice-list">
          {announcements.map((announcement) => (
            <article className={announcementClasses(announcement)} key={announcement.id}>
              <span className="notice__icon">
                {announcement.pinned ? <BellIcon /> : <MegaphoneIcon />}
              </span>
              <div className="notice__content">
                <div className="notice__meta">
                  <span className="badge badge--soft">{TONE_LABELS[announcement.tone]}</span>
                  {announcement.pinned ? <span className="badge badge--gold">مثبّت</span> : null}
                  <span className="muted small">{formatDateTime(announcement.createdAt)}</span>
                </div>
                <h2>{announcement.title}</h2>
                <p>{announcement.body}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
