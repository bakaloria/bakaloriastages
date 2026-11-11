import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
    <section className="notice-stack" aria-label="إعلانات المنصة">
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
          <div className="notice__content">
            <strong>{announcement.title}</strong>
            <p>{announcement.body}</p>
          </div>
          <Link to="/notifications" className="notice__link">
            كل الإشعارات
            <ChevronLeftIcon />
          </Link>
        </article>
      ))}
    </section>
  );
}
