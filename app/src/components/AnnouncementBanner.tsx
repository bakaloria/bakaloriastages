import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BellIcon, ChevronLeftIcon, MegaphoneIcon } from "./Icons";
import { fetchActiveAnnouncements } from "../lib/announcements";
import type { Announcement } from "../lib/types";

export function toneClass(tone: Announcement["tone"]): string {
  return `notice notice--${tone}`;
}

export function AnnouncementBanner() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  useEffect(() => {
    let active = true;
    void fetchActiveAnnouncements()
      .then((rows) => {
        if (active) setAnnouncements(rows.slice(0, 2));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (announcements.length === 0) return null;

  return (
    <section className="notice-stack" aria-label="إعلانات المنصة">
      {announcements.map((announcement) => (
        <article className={toneClass(announcement.tone)} key={announcement.id}>
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
