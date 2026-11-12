import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AnnouncementContent } from "./AnnouncementContent";
import { BellIcon, ChevronLeftIcon, MegaphoneIcon } from "./Icons";
import { useAuth } from "../context/AuthContext";
import {
  announcementClasses,
  announcementRenderKey,
  announcementStyle,
  subscribeActiveAnnouncements,
} from "../lib/announcements";
import type { Announcement } from "../lib/types";

export function toneClass(tone: Announcement["tone"]): string {
  return `notice notice--${tone}`;
}

export function AnnouncementBanner() {
  const { settings } = useAuth();
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  useEffect(
    () =>
      subscribeActiveAnnouncements((rows) => {
        setAnnouncements(rows.slice(0, 2));
      }),
    [],
  );

  if (announcements.length === 0 && !settings.maintenanceMessage) return null;

  return (
    <section className="notice-feed" aria-label="إعلانات المنصة">
      {announcements.length > 0 ? (
        <div className="notice-feed__head">
          <span className="notice-feed__title">
            <MegaphoneIcon />
            إعلانات المنصة
          </span>
          <Link to="/notifications" className="notice-feed__link">
            كل الإشعارات
            <ChevronLeftIcon />
          </Link>
        </div>
      ) : null}
      <div className="notice-stack">
        {settings.maintenanceMessage ? (
          <article className="notice notice--warning">
            <span className="notice__icon">
              <BellIcon />
            </span>
            <div className="notice__content">
              <strong>تنبيه من الإدارة</strong>
              <p>{settings.maintenanceMessage}</p>
            </div>
          </article>
        ) : null}
        {announcements.map((announcement) => (
          <article
            className={announcementClasses(announcement)}
            key={announcementRenderKey(announcement)}
            style={announcementStyle(announcement)}
          >
            <span className="notice__icon">
              {announcement.pinned ? <BellIcon /> : <MegaphoneIcon />}
            </span>
            <AnnouncementContent
              title={announcement.title}
              body={announcement.body}
              banner={announcement.animation === "banner"}
            />
          </article>
        ))}
      </div>
    </section>
  );
}
