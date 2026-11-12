import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import type { GlobalSettings, SubjectSettings } from "./types";

export const DEFAULT_SUBJECT_SETTINGS: SubjectSettings = {
  // Five questions per stage remains the recommended default, but the split is
  // now fully editable from the admin dashboard.
  stageSize: 5,
  newPerStage: 3,
  reviewPerStage: 2,
  failedNewPerStage: 2,
  failedReviewPerStage: 3,
  passThreshold: 60,
  sessionStages: 10,
  intervalMinutes: 120,
  // Optional pause between two stages. Zero keeps the original behaviour:
  // the next stage opens as soon as the student confirms they saw feedback.
  stageIntervalMinutes: 0,
  wrongIntervalMinutes: 10,
  masteryThreshold: 1,
  finalExamRequired: false,
  stagesLocked: false,
  lockMessage: "",
};

export const DEFAULT_BACKGROUND_COLOR = "#f7f3ea";
export const DEFAULT_SURFACE_COLOR = "#fffdf9";
export const DEFAULT_TEXT_COLOR = "#122a28";
export const DEFAULT_ACCENT_COLOR = "#0f5a4e";
export const DEFAULT_WAIT_BACKGROUND_COLOR = "#0b3e36";
export const DEFAULT_WAIT_TEXT_COLOR = "#f8f4ea";

export const BACKGROUND_PRESETS = [
  { label: "ورقي دافئ", value: "#f7f3ea" },
  { label: "أبيض هادئ", value: "#f5f7f6" },
  { label: "رملي فاتح", value: "#f6efe3" },
  { label: "أزرق سماوي", value: "#eaf2f8" },
  { label: "أخضر نعناعي", value: "#eaf5ef" },
  { label: "وردي ناعم", value: "#faeef0" },
  { label: "بنفسجي فاتح", value: "#f1edf8" },
  { label: "رمادي فضي", value: "#eef1f2" },
] as const;

export interface StudentPalette {
  id: string;
  label: string;
  description: string;
  backgroundColor: string;
  surfaceColor: string;
  textColor: string;
  accentColor: string;
  waitBackgroundColor: string;
  waitTextColor: string;
}

export const STUDENT_PALETTES: StudentPalette[] = [
  {
    id: "paper",
    label: "ورقي دافئ",
    description: "الألوان الأصلية، فاتحة ومريحة للقراءة.",
    backgroundColor: DEFAULT_BACKGROUND_COLOR,
    surfaceColor: DEFAULT_SURFACE_COLOR,
    textColor: DEFAULT_TEXT_COLOR,
    accentColor: DEFAULT_ACCENT_COLOR,
    waitBackgroundColor: DEFAULT_WAIT_BACKGROUND_COLOR,
    waitTextColor: DEFAULT_WAIT_TEXT_COLOR,
  },
  {
    id: "mint",
    label: "نعناعي هادئ",
    description: "خلفية خضراء فاتحة وبطاقات بيضاء.",
    backgroundColor: "#eaf5ef",
    surfaceColor: "#fbfffd",
    textColor: "#12312c",
    accentColor: "#146b5b",
    waitBackgroundColor: "#0d4a3f",
    waitTextColor: "#f2fbf7",
  },
  {
    id: "sand",
    label: "رملي ذهبي",
    description: "دفء الورق مع لمسة ذهبية.",
    backgroundColor: "#f6efe3",
    surfaceColor: "#fffaf0",
    textColor: "#31281c",
    accentColor: "#8a5c1b",
    waitBackgroundColor: "#4d3719",
    waitTextColor: "#fff7e6",
  },
  {
    id: "ocean",
    label: "أزرق المحيط",
    description: "أزرق فاتح قريب من ألوان السماء.",
    backgroundColor: "#eaf2f8",
    surfaceColor: "#fbfdff",
    textColor: "#142833",
    accentColor: "#1d6b8a",
    waitBackgroundColor: "#123a4d",
    waitTextColor: "#f2fbff",
  },
  {
    id: "midnight",
    label: "ليلي زمردي",
    description: "وضع داكن كامل بنصوص فاتحة وتباين عالٍ.",
    backgroundColor: "#081816",
    surfaceColor: "#102522",
    textColor: "#f3f0e7",
    accentColor: "#54c7a7",
    waitBackgroundColor: "#123f37",
    waitTextColor: "#f3f0e7",
  },
  {
    id: "charcoal",
    label: "فحمي أنيق",
    description: "خلفية فحمية وبطاقات رمادية داكنة.",
    backgroundColor: "#15191b",
    surfaceColor: "#20272a",
    textColor: "#f4f1eb",
    accentColor: "#d4a24c",
    waitBackgroundColor: "#2a2f32",
    waitTextColor: "#f4f1eb",
  },
  {
    id: "plum",
    label: "بنفسجي ليلي",
    description: "داكن هادئ مع لمسة بنفسجية.",
    backgroundColor: "#1b1220",
    surfaceColor: "#281b2f",
    textColor: "#f7effa",
    accentColor: "#c58adf",
    waitBackgroundColor: "#3a2245",
    waitTextColor: "#fbf4ff",
  },
];

export function normalizeThemeColor(value: unknown, fallback: string): string {
  const color = String(value ?? "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
}

export function normalizeBackgroundColor(value: unknown): string {
  return normalizeThemeColor(value, DEFAULT_BACKGROUND_COLOR);
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(channels: [number, number, number]): string {
  return `#${channels
    .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function shiftColor(hex: string, amount: number): string {
  const channels = hexToRgb(hex).map((channel) =>
    Math.max(0, Math.min(255, channel + amount)),
  );
  return rgbToHex([channels[0], channels[1], channels[2]]);
}

function mixColors(base: string, overlay: string, weight: number): string {
  const a = hexToRgb(base);
  const b = hexToRgb(overlay);
  return rgbToHex([
    a[0] + (b[0] - a[0]) * weight,
    a[1] + (b[1] - a[1]) * weight,
    a[2] + (b[2] - a[2]) * weight,
  ]);
}

function relativeLuminance(hex: string): number {
  const channels = hexToRgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(normalizeThemeColor(foreground, DEFAULT_TEXT_COLOR));
  const second = relativeLuminance(normalizeThemeColor(background, DEFAULT_BACKGROUND_COLOR));
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function ensureDark(hex: string, maxLuminance: number): string {
  let color = hex;
  for (let index = 0; index < 24 && relativeLuminance(color) > maxLuminance; index += 1) {
    color = shiftColor(color, -14);
  }
  return color;
}

export function paletteMatches(
  settings: Pick<GlobalSettings, "backgroundColor" | "surfaceColor" | "textColor" | "accentColor">,
  palette: StudentPalette,
): boolean {
  return (
    settings.backgroundColor.toLowerCase() === palette.backgroundColor &&
    settings.surfaceColor.toLowerCase() === palette.surfaceColor &&
    settings.textColor.toLowerCase() === palette.textColor &&
    settings.accentColor.toLowerCase() === palette.accentColor
  );
}

export function applyStudentPalette(
  value: Pick<
    GlobalSettings,
    | "backgroundColor"
    | "surfaceColor"
    | "textColor"
    | "accentColor"
    | "waitBackgroundColor"
    | "waitTextColor"
  >,
): void {
  if (typeof document === "undefined") return;
  const background = normalizeThemeColor(value.backgroundColor, DEFAULT_BACKGROUND_COLOR);
  const surface = normalizeThemeColor(value.surfaceColor, DEFAULT_SURFACE_COLOR);
  const text = normalizeThemeColor(value.textColor, DEFAULT_TEXT_COLOR);
  const accent = normalizeThemeColor(value.accentColor, DEFAULT_ACCENT_COLOR);
  const waitBackground = normalizeThemeColor(
    value.waitBackgroundColor,
    DEFAULT_WAIT_BACKGROUND_COLOR,
  );
  const waitText = normalizeThemeColor(value.waitTextColor, DEFAULT_WAIT_TEXT_COLOR);
  const [backgroundRed, backgroundGreen, backgroundBlue] = hexToRgb(background);
  const [surfaceRed, surfaceGreen, surfaceBlue] = hexToRgb(surface);
  const [textRed, textGreen, textBlue] = hexToRgb(text);
  const [waitBackgroundRed, waitBackgroundGreen, waitBackgroundBlue] =
    hexToRgb(waitBackground);
  const [waitTextRed, waitTextGreen, waitTextBlue] = hexToRgb(waitText);
  const surfaceIsDark = relativeLuminance(surface) < 0.45;
  const backgroundIsDark = relativeLuminance(background) < 0.45;
  const accentDark = ensureDark(shiftColor(accent, -18), 0.24);
  const accentDeep = ensureDark(shiftColor(accent, -38), 0.14);
  const root = document.documentElement;

  root.style.setProperty("--bg", background);
  root.style.setProperty("--bg-rgb", `${backgroundRed}, ${backgroundGreen}, ${backgroundBlue}`);
  root.style.setProperty("--bg-deep", shiftColor(background, backgroundIsDark ? 18 : -14));
  root.style.setProperty("--surface", surface);
  root.style.setProperty("--surface-rgb", `${surfaceRed}, ${surfaceGreen}, ${surfaceBlue}`);
  root.style.setProperty(
    "--surface-2",
    mixColors(surface, text, surfaceIsDark ? 0.13 : 0.07),
  );
  root.style.setProperty("--ink", text);
  root.style.setProperty("--ink-rgb", `${textRed}, ${textGreen}, ${textBlue}`);
  root.style.setProperty("--ink-soft", mixColors(text, surface, 0.28));
  root.style.setProperty("--muted", mixColors(text, surface, 0.45));
  root.style.setProperty("--line", `rgba(${textRed}, ${textGreen}, ${textBlue}, ${surfaceIsDark ? 0.2 : 0.1})`);
  root.style.setProperty(
    "--line-strong",
    `rgba(${textRed}, ${textGreen}, ${textBlue}, ${surfaceIsDark ? 0.3 : 0.16})`,
  );
  root.style.setProperty("--green", accent);
  root.style.setProperty("--green-dark", accentDark);
  root.style.setProperty("--green-deep", accentDeep);
  root.style.setProperty(
    "--green-soft",
    mixColors(accent, surface, surfaceIsDark ? 0.78 : 0.86),
  );
  const waitBackgroundIsDark = relativeLuminance(waitBackground) < 0.45;
  root.style.setProperty("--wait-bg", waitBackground);
  root.style.setProperty(
    "--wait-bg-deep",
    shiftColor(waitBackground, waitBackgroundIsDark ? 10 : -24),
  );
  root.style.setProperty("--wait-text", waitText);
  root.style.setProperty(
    "--wait-text-rgb",
    `${waitTextRed}, ${waitTextGreen}, ${waitTextBlue}`,
  );
  root.style.setProperty("--wait-muted", mixColors(waitText, waitBackground, 0.3));
}

export function applyBackgroundColor(value: unknown): void {
  if (typeof document === "undefined") return;
  const color = normalizeBackgroundColor(value);
  const [r, g, b] = hexToRgb(color);
  const root = document.documentElement;
  root.style.setProperty("--bg", color);
  root.style.setProperty("--bg-rgb", `${r}, ${g}, ${b}`);
  root.style.setProperty(
    "--bg-deep",
    color === DEFAULT_BACKGROUND_COLOR ? "#efe9dc" : shiftColor(color, -14),
  );
}

export const DEFAULT_CERTIFICATE_NOTICE =
  "الشهادة الرسمية تحتاج إلى اعتماد من الجهات المختصة. إتمام المراجعة داخل المنصة سجل تدريبي، ولا يعني الحصول على شهادة رسمية.";

export const DEFAULT_FINAL_EXAM_REMINDER =
  "من اقترب من إتمام المراجعة أصبح أقرب إلى النجاح في امتحان الشهادة الأخير؛ فليواصل بثبات.";

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  stagesLocked: false,
  registrationsOpen: true,
  lockMessage: "",
  maintenanceMessage: "",
  backgroundColor: DEFAULT_BACKGROUND_COLOR,
  surfaceColor: DEFAULT_SURFACE_COLOR,
  textColor: DEFAULT_TEXT_COLOR,
  accentColor: DEFAULT_ACCENT_COLOR,
  waitBackgroundColor: DEFAULT_WAIT_BACKGROUND_COLOR,
  waitTextColor: DEFAULT_WAIT_TEXT_COLOR,
  certificateClaimsEnabled: false,
  certificateNotice: DEFAULT_CERTIFICATE_NOTICE,
  finalExamReminder: DEFAULT_FINAL_EXAM_REMINDER,
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeSubjectSettings(data: Partial<SubjectSettings> | null): SubjectSettings {
  const merged = { ...DEFAULT_SUBJECT_SETTINGS, ...(data ?? {}) };
  const newPerStage = clamp(merged.newPerStage, 0, 10, DEFAULT_SUBJECT_SETTINGS.newPerStage);
  const reviewPerStage = clamp(
    merged.reviewPerStage,
    0,
    10,
    DEFAULT_SUBJECT_SETTINGS.reviewPerStage,
  );
  return {
    stageSize: Math.max(
      1,
      Math.min(20, newPerStage + reviewPerStage || Number(merged.stageSize) || 5),
    ),
    newPerStage,
    reviewPerStage,
    failedNewPerStage: clamp(
      merged.failedNewPerStage,
      0,
      10,
      DEFAULT_SUBJECT_SETTINGS.failedNewPerStage,
    ),
    failedReviewPerStage: clamp(
      merged.failedReviewPerStage,
      0,
      10,
      DEFAULT_SUBJECT_SETTINGS.failedReviewPerStage,
    ),
    passThreshold: clamp(
      merged.passThreshold,
      0,
      100,
      DEFAULT_SUBJECT_SETTINGS.passThreshold,
    ),
    sessionStages: clamp(
      merged.sessionStages,
      1,
      50,
      DEFAULT_SUBJECT_SETTINGS.sessionStages,
    ),
    intervalMinutes: clamp(
      merged.intervalMinutes,
      0,
      7 * 24 * 60,
      DEFAULT_SUBJECT_SETTINGS.intervalMinutes,
    ),
    stageIntervalMinutes: clamp(
      merged.stageIntervalMinutes,
      0,
      7 * 24 * 60,
      DEFAULT_SUBJECT_SETTINGS.stageIntervalMinutes,
    ),
    wrongIntervalMinutes: clamp(
      merged.wrongIntervalMinutes,
      1,
      7 * 24 * 60,
      DEFAULT_SUBJECT_SETTINGS.wrongIntervalMinutes,
    ),
    masteryThreshold: clamp(
      merged.masteryThreshold,
      0,
      1,
      DEFAULT_SUBJECT_SETTINGS.masteryThreshold,
    ),
    finalExamRequired: Boolean(merged.finalExamRequired),
    stagesLocked: Boolean(merged.stagesLocked),
    lockMessage: String(merged.lockMessage ?? "").trim(),
  };
}

export function normalizeGlobalSettings(data: Partial<GlobalSettings> | null): GlobalSettings {
  const merged = { ...DEFAULT_GLOBAL_SETTINGS, ...(data ?? {}) };
  return {
    stagesLocked: Boolean(merged.stagesLocked),
    registrationsOpen: merged.registrationsOpen !== false,
    lockMessage: String(merged.lockMessage ?? "").trim(),
    maintenanceMessage: String(merged.maintenanceMessage ?? "").trim(),
    backgroundColor: normalizeBackgroundColor(merged.backgroundColor),
    surfaceColor: normalizeThemeColor(merged.surfaceColor, DEFAULT_SURFACE_COLOR),
    textColor: normalizeThemeColor(merged.textColor, DEFAULT_TEXT_COLOR),
    accentColor: normalizeThemeColor(merged.accentColor, DEFAULT_ACCENT_COLOR),
    waitBackgroundColor: normalizeThemeColor(
      merged.waitBackgroundColor,
      DEFAULT_WAIT_BACKGROUND_COLOR,
    ),
    waitTextColor: normalizeThemeColor(merged.waitTextColor, DEFAULT_WAIT_TEXT_COLOR),
    certificateClaimsEnabled: merged.certificateClaimsEnabled === true,
    certificateNotice: String(
      merged.certificateNotice ?? DEFAULT_CERTIFICATE_NOTICE,
    ).trim(),
    finalExamReminder: String(
      merged.finalExamReminder ?? DEFAULT_FINAL_EXAM_REMINDER,
    ).trim(),
  };
}

export async function fetchSubjectSettings(subjectId: string): Promise<SubjectSettings> {
  if (!db) return normalizeSubjectSettings(null);
  const snap = await getDoc(doc(db, "subject_settings", subjectId));
  return normalizeSubjectSettings(snap.exists() ? (snap.data() as Partial<SubjectSettings>) : null);
}

export async function fetchGlobalSettings(): Promise<GlobalSettings> {
  if (!db) return normalizeGlobalSettings(null);
  const snap = await getDoc(doc(db, "settings", "global"));
  return normalizeGlobalSettings(snap.exists() ? (snap.data() as Partial<GlobalSettings>) : null);
}

export async function saveSubjectSettings(
  subjectId: string,
  settings: SubjectSettings,
  updatedBy: string,
): Promise<SubjectSettings> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const normalized = normalizeSubjectSettings(settings);
  await setDoc(
    doc(db, "subject_settings", subjectId),
    {
      ...normalized,
      updatedAt: serverTimestamp(),
      updatedBy,
    },
    { merge: true },
  );
  return normalized;
}

export async function saveGlobalSettings(
  settings: GlobalSettings,
  updatedBy: string,
): Promise<GlobalSettings> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const normalized = normalizeGlobalSettings(settings);
  await setDoc(
    doc(db, "settings", "global"),
    {
      ...normalized,
      updatedAt: serverTimestamp(),
      updatedBy,
    },
    { merge: true },
  );
  return normalized;
}
