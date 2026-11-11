import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BellIcon, ChevronLeftIcon, MegaphoneIcon } from "./Icons";
import {
  announcementClasses,
  fetchActiveAnnouncements,
} from "../lib/announcements";
import { fetchGlobalSettings } from "../lib/settings";
import type { Announcement } from "../lib/types";

export function toneClass(tone: Announcement["tone"]): string {
  return `notice notice--${tone}`;
}

export function AnnouncementBanner() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([fetchActiveAnnouncements(), fetchGlobalSettings()])
      .then(([rows, settings]) => {
        if (!active) return;
        setAnnouncements(rows.slice(0, 2));
        setMaintenanceMessage(settings.maintenanceMessage);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (announcements.length === 0 && !maintenanceMessage) return null;

  return (
    <section className="notice-stack" aria-label="إعلانات المنصة">
      {maintenanceMessage ? (
        <article className="notice notice--warning">
          <span className="notice__icon">
            <BellIcon />
          </span>
          <div className="notice__content">
            <strong>تنبيه من الإدارة</strong>
            <p>{maintenanceMessage}</p>
          </div>
        </article>
      ) : null}
      {announcements.map((announcement) => (
        <article className={announcementClasses(announcement)} key={announcement.id}>
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
