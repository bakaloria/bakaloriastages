import type { CSSProperties } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "./firebase";
import type {
  Announcement,
  AnnouncementAnimation,
  AnnouncementFont,
  AnnouncementPattern,
  AnnouncementSpeed,
  AnnouncementTone,
  Profile,
} from "./types";

const SEEN_KEY = "bakaloriastages.seenAnnouncements";

export const ANNOUNCEMENT_ANIMATIONS: Array<{
  value: AnnouncementAnimation;
  label: string;
  description: string;
}> = [
  { value: "none", label: "بدون حركة", description: "ثابت وهادئ" },
  {
    value: "banner",
    label: "بانر متحرك",
    description: "الإطار ثابت والنص يتحرك",
  },
  { value: "slide-right", label: "دخول من اليمين", description: "انزلاق من جهة البداية" },
  { value: "slide-left", label: "دخول من اليسار", description: "انزلاق من الجهة المقابلة" },
  { value: "slide-up", label: "صعود من الأسفل", description: "ظهور تدريجي من الأسفل" },
  { value: "slide-down", label: "هبوط من الأعلى", description: "ظهور تدريجي من الأعلى" },
  { value: "fade", label: "تلاشي هادئ", description: "ظهور وتلاشي ناعم" },
  { value: "zoom-in", label: "تكبير", description: "يتقارب من المركز" },
  { value: "zoom-out", label: "تصغير", description: "يبدأ أكبر ثم يستقر" },
  { value: "bounce", label: "قفز خفيف", description: "حركة رأسية متكررة" },
  { value: "pulse", label: "نبض", description: "تنفس بصري متكرر" },
  { value: "shake", label: "اهتزاز", description: "تنبيه أفقي متكرر" },
  { value: "swing", label: "تمايل", description: "حركة دورانية خفيفة" },
  { value: "flip", label: "انقلاب", description: "دوران ثلاثي الأبعاد" },
  { value: "rotate", label: "دوران", description: "يدخل بزاوية ثم يستقر" },
  { value: "float", label: "طائر", description: "طفو رأسي هادئ" },
  { value: "orbit", label: "حركة دائرية", description: "مسار دائري صغير متكرر" },
];

export const ANNOUNCEMENT_FONTS: Array<{
  value: AnnouncementFont;
  label: string;
  sample: string;
}> = [
  { value: "default", label: "الخط الافتراضي", sample: "مراحل البكالوريا" },
  { value: "cairo", label: "القاهرة", sample: "علمٌ يُبنى بالمراجعة" },
  { value: "amiri", label: "أميري", sample: "خط كلاسيكي أنيق" },
  { value: "scheherazade", label: "شهرزاد", sample: "نص عربي واضح" },
  { value: "aref", label: "عارف رقعة", sample: "زخرفة رقعة" },
  { value: "reem", label: "ريم كوفي", sample: "كوفي إسلامي" },
  { value: "lateef", label: "لطيف", sample: "نسخ هادئ" },
  { value: "naskh", label: "نسخ حديث", sample: "قراءة مريحة" },
  { value: "rakkas", label: "رقّاص", sample: "زخرفة قوية" },
  { value: "lalezar", label: "لاله زار", sample: "عنوان لافت" },
  { value: "messiri", label: "المسيري", sample: "زخرفة عربية أنيقة" },
  { value: "changa", label: "شنقا", sample: "حروف إسلامية هندسية" },
  { value: "harmattan", label: "هرمتان", sample: "نسخ إسلامي واضح" },
  { value: "mada", label: "مدى", sample: "خط عصري بسيط" },
  { value: "marhey", label: "مرحى", sample: "زخرفة مرحة" },
  { value: "kufi", label: "كوفي نوتو", sample: "كوفي هندسي" },
  { value: "readex", label: "ريدكس", sample: "قراءة عربية حديثة" },
  { value: "alexandria", label: "الإسكندرية", sample: "عنوان عربي قوي" },
  { value: "rubik", label: "روبيك", sample: "خط عصري متوازن" },
  { value: "nastaliq", label: "نستعليق", sample: "زخرفة خطية فارسية" },
];

export const ANNOUNCEMENT_SPEEDS: Array<{
  value: AnnouncementSpeed;
  label: string;
}> = [
  { value: "slow", label: "هادئة" },
  { value: "normal", label: "متوسطة" },
  { value: "fast", label: "سريعة" },
];

export const ANNOUNCEMENT_BACKGROUNDS: Array<{
  value: string;
  label: string;
}> = [
  { value: "", label: "افتراضي حسب النوع" },
  { value: "#fffaf0", label: "ورقي دافئ" },
  { value: "#eaf7f0", label: "نعناعي" },
  { value: "#eaf4fb", label: "سماوي" },
  { value: "#fdeef2", label: "وردي ناعم" },
  { value: "#f3edfb", label: "لافندر" },
  { value: "#fbf1d9", label: "ذهبي فاتح" },
  { value: "#f6efe3", label: "رملي" },
  { value: "#e3f4ec", label: "زمردي" },
  { value: "#17332f", label: "أخضر ليلي" },
  { value: "#202a2a", label: "فحمي" },
  { value: "#3a1622", label: "خمري" },
  { value: "#13283d", label: "أزرق داكن" },
];

export const ANNOUNCEMENT_PATTERNS: Array<{
  value: AnnouncementPattern;
  label: string;
}> = [
  { value: "none", label: "بدون زخرفة" },
  { value: "arabesque", label: "أرابيسك إسلامي" },
  { value: "geometric", label: "هندسي إسلامي" },
  { value: "dots", label: "نقاط" },
  { value: "grid", label: "شبكة" },
  { value: "stars", label: "نجوم" },
  { value: "waves", label: "موجات" },
];

const ANIMATION_VALUES = new Set(ANNOUNCEMENT_ANIMATIONS.map((item) => item.value));
const FONT_VALUES = new Set(ANNOUNCEMENT_FONTS.map((item) => item.value));
const SPEED_VALUES = new Set(ANNOUNCEMENT_SPEEDS.map((item) => item.value));
const PATTERN_VALUES = new Set(ANNOUNCEMENT_PATTERNS.map((item) => item.value));

function asAnimation(value: unknown): AnnouncementAnimation {
  return ANIMATION_VALUES.has(value as AnnouncementAnimation)
    ? (value as AnnouncementAnimation)
    : "none";
}

function asFont(value: unknown): AnnouncementFont {
  return FONT_VALUES.has(value as AnnouncementFont)
    ? (value as AnnouncementFont)
    : "default";
}

function asSpeed(value: unknown): AnnouncementSpeed {
  return SPEED_VALUES.has(value as AnnouncementSpeed)
    ? (value as AnnouncementSpeed)
    : "normal";
}

function asPattern(value: unknown): AnnouncementPattern {
  return PATTERN_VALUES.has(value as AnnouncementPattern)
    ? (value as AnnouncementPattern)
    : "none";
}

export function normalizeAnnouncementColor(value: unknown): string {
  const color = String(value ?? "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : "";
}

function readableTextColor(background: string): string {
  const red = Number.parseInt(background.slice(1, 3), 16);
  const green = Number.parseInt(background.slice(3, 5), 16);
  const blue = Number.parseInt(background.slice(5, 7), 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance < 0.55 ? "#ffffff" : "#122a28";
}

export function announcementFromDoc(
  id: string,
  data: Record<string, unknown>,
): Announcement {
  const tone =
    data.tone === "success" || data.tone === "warning" || data.tone === "danger"
      ? (data.tone as AnnouncementTone)
      : "info";
  const animation = asAnimation(data.animation);
  return {
    id,
    title: String(data.title ?? ""),
    body: String(data.body ?? ""),
    tone,
    animation,
    font: asFont(data.font),
    speed: asSpeed(data.speed ?? data.animationSpeed),
    background: normalizeAnnouncementColor(data.background ?? data.backgroundColor),
    pattern: asPattern(data.pattern ?? data.backgroundPattern),
    textColor: normalizeAnnouncementColor(data.textColor),
    loop: animation === "banner" || (data.loop !== false && data.animationLoop !== false),
    active: data.active !== false,
    pinned: Boolean(data.pinned),
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    expiresAt: data.expiresAt,
    createdBy: String(data.createdBy ?? ""),
  };
}

export function announcementClasses(
  announcement: Pick<
    Announcement,
    "tone" | "animation" | "font" | "speed" | "pattern" | "loop" | "background"
  >,
): string {
  return [
    "notice",
    `notice--${announcement.tone}`,
    `notice--anim-${announcement.animation}`,
    `notice--font-${announcement.font}`,
    `notice--speed-${announcement.speed}`,
    `notice--pattern-${announcement.pattern}`,
    announcement.background ? "notice--custom-bg" : "",
    announcement.loop ? "notice--loop" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function announcementStyle(
  announcement: Pick<Announcement, "background" | "textColor">,
): CSSProperties {
  const style: CSSProperties = {};
  if (announcement.background) {
    style.backgroundColor = announcement.background;
    if (!announcement.textColor) {
      style.color = readableTextColor(announcement.background);
    }
  }
  if (announcement.textColor) style.color = announcement.textColor;
  return style;
}

export function announcementRenderKey(
  announcement: Pick<
    Announcement,
    "id" | "animation" | "font" | "speed" | "background" | "pattern" | "textColor" | "loop"
  >,
): string {
  return [
    announcement.id,
    announcement.animation,
    announcement.font,
    announcement.speed,
    announcement.background,
    announcement.pattern,
    announcement.textColor,
    announcement.loop ? "loop" : "once",
  ].join("|");
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

function sortAnnouncements(rows: Announcement[]): Announcement[] {
  return rows
    .filter((item) => isAnnouncementLive(item))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (expiryMillis(b.createdAt) ?? 0) - (expiryMillis(a.createdAt) ?? 0);
    });
}

export async function fetchActiveAnnouncements(): Promise<Announcement[]> {
  if (!db) return [];
  const snap = await getDocs(
    query(collection(db, "announcements"), where("active", "==", true), limit(50)),
  );
  return sortAnnouncements(
    snap.docs.map((item) => announcementFromDoc(item.id, item.data())),
  );
}

export function subscribeActiveAnnouncements(
  onRows: (announcements: Announcement[]) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  if (!db) {
    onRows([]);
    return () => undefined;
  }
  return onSnapshot(
    query(collection(db, "announcements"), where("active", "==", true), limit(50)),
    (snap) => {
      onRows(
        sortAnnouncements(snap.docs.map((item) => announcementFromDoc(item.id, item.data()))),
      );
    },
    (error) => {
      onError?.(error);
    },
  );
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
    animation: AnnouncementAnimation;
    font: AnnouncementFont;
    speed: AnnouncementSpeed;
    background: string;
    pattern: AnnouncementPattern;
    textColor: string;
    loop: boolean;
    active: boolean;
    pinned: boolean;
    expiresAt: number | null;
  },
  admin: Profile,
): Promise<void> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const animation = asAnimation(input.animation);
  const payload = {
    title: input.title.trim(),
    body: input.body.trim(),
    tone: input.tone,
    animation,
    font: asFont(input.font),
    speed: asSpeed(input.speed),
    background: normalizeAnnouncementColor(input.background),
    pattern: asPattern(input.pattern),
    textColor: normalizeAnnouncementColor(input.textColor),
    loop: animation === "banner" ? true : input.loop,
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
