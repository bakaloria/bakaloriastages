import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
} from "firebase/firestore";
import { db } from "./firebase";
import type { Announcement, AnnouncementTone, Profile } from "./types";

const SEEN_KEY = "bakaloriastages.seenAnnouncements";

export function announcementFromDoc(
  id: string,
  data: Record<string, unknown>,
): Announcement {
  const tone =
    data.tone === "success" || data.tone === "warning" || data.tone === "danger"
      ? (data.tone as AnnouncementTone)
      : "info";
  return {
    id,
    title: String(data.title ?? ""),
    body: String(data.body ?? ""),
    tone,
    active: data.active !== false,
    pinned: Boolean(data.pinned),
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    expiresAt: data.expiresAt,
    createdBy: String(data.createdBy ?? ""),
  };
}

function expiryMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const candidate = value as { toMillis?: () => number; seconds?: number };
    if (typeof candidate.toMillis === "function") return candidate.toMillis();
    if (typeof candidate.seconds === "number") return candidate.seconds * 1000;
  }
  return null;
}

export function isAnnouncementLive(announcement: Announcement, now = Date.now()): boolean {
  const expires = expiryMillis(announcement.expiresAt);
  return announcement.active && (expires === null || expires > now);
}

export async function fetchActiveAnnouncements(): Promise<Announcement[]> {
  if (!db) return [];
  const snap = await getDocs(
    query(collection(db, "announcements"), where("active", "==", true), limit(50)),
  );
  return snap.docs
    .map((item) => announcementFromDoc(item.id, item.data()))
    .filter((item) => isAnnouncementLive(item))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (expiryMillis(b.createdAt) ?? 0) - (expiryMillis(a.createdAt) ?? 0);
    });
}

export async function fetchAllAnnouncements(): Promise<Announcement[]> {
  if (!db) return [];
  const snap = await getDocs(
    query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(100)),
  );
  return snap.docs.map((item) => announcementFromDoc(item.id, item.data()));
}

export async function saveAnnouncement(
  input: {
    id?: string;
    title: string;
    body: string;
    tone: AnnouncementTone;
    active: boolean;
    pinned: boolean;
    expiresAt: number | null;
  },
  admin: Profile,
): Promise<void> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const payload = {
    title: input.title.trim(),
    body: input.body.trim(),
    tone: input.tone,
    active: input.active,
    pinned: input.pinned,
    expiresAt: input.expiresAt ? Timestamp.fromMillis(input.expiresAt) : null,
    updatedAt: serverTimestamp(),
    updatedBy: admin.uid,
  };
  if (input.id) {
    await setDoc(doc(db, "announcements", input.id), payload, { merge: true });
  } else {
    await addDoc(collection(db, "announcements"), {
      ...payload,
      createdAt: serverTimestamp(),
      createdBy: admin.uid,
    });
  }
}

export async function removeAnnouncement(id: string): Promise<void> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  await deleteDoc(doc(db, "announcements", id));
}

export function readSeenAnnouncements(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function markAnnouncementsSeen(ids: string[]): void {
  try {
    const merged = new Set([...readSeenAnnouncements(), ...ids]);
    localStorage.setItem(SEEN_KEY, JSON.stringify([...merged].slice(-200)));
  } catch {
    // Private browsing can block storage; the page still works without a badge.
  }
}

export function unseenAnnouncementCount(announcements: Announcement[]): number {
  const seen = new Set(readSeenAnnouncements());
  return announcements.filter((item) => !seen.has(item.id)).length;
}

export async function logAdminAction(
  admin: Profile,
  action: string,
  detail: string,
): Promise<void> {
  if (!db) return;
  try {
    await addDoc(collection(db, "admin_audit"), {
      action,
      detail,
      adminUid: admin.uid,
      adminName: admin.displayName,
      createdAt: serverTimestamp(),
    });
  } catch {
    // An audit write must never block the action the admin actually requested.
  }
}
