import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from "firebase/auth";
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { AnnouncementContent } from "../components/AnnouncementContent";
import {
  AwardIcon,
  BellIcon,
  BookIcon,
  CheckIcon,
  LockIcon,
  MegaphoneIcon,
  RefreshIcon,
  SettingsIcon,
  ShieldIcon,
  SparklesIcon,
  TrashIcon,
  TrophyIcon,
  UserIcon,
  XIcon,
} from "../components/Icons";
import { InlineLoader } from "../components/Loading";
import { QuestionBankPanel } from "../components/QuestionBankPanel";
import { useAuth } from "../context/AuthContext";
import {
  ANNOUNCEMENT_ANIMATIONS,
  ANNOUNCEMENT_BACKGROUNDS,
  ANNOUNCEMENT_FONTS,
  ANNOUNCEMENT_PATTERNS,
  ANNOUNCEMENT_SPEEDS,
  announcementClasses,
  announcementStyle,
  fetchAllAnnouncements,
  isAnnouncementLive,
  logAdminAction,
  removeAnnouncement,
  saveAnnouncement,
} from "../lib/announcements";
import { errorMessage } from "../lib/errors";
import { auth, db } from "../lib/firebase";
import { formatDateTime, formatNumber, toMillis } from "../lib/format";
import {
  applyStudentPalette,
  BACKGROUND_PRESETS,
  contrastRatio,
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_SUBJECT_SETTINGS,
  fetchGlobalSettings,
  fetchSubjectSettings,
  normalizeGlobalSettings,
  normalizeSubjectSettings,
  paletteMatches,
  saveGlobalSettings,
  saveSubjectSettings,
  STUDENT_PALETTES,
  type StudentPalette,
} from "../lib/settings";
import type {
  AdminAuditEntry,
  AdminUserRow,
  Announcement,
  AnnouncementAnimation,
  AnnouncementFont,
  AnnouncementPattern,
  AnnouncementSpeed,
  AnnouncementTone,
  Branch,
  GlobalSettings,
  Profile,
  Subject,
  SubjectSettings,
} from "../lib/types";

type Tab = "overview" | "subjects" | "questions" | "announcements" | "students" | "account";

interface Stats {
  users: number;
  questions: number;
  enrollments: number;
  attempts: number;
}

interface AnnouncementDraft {
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
  publishAt: string;
  expiresAt: string;
}

type StudentBranchFilter = "all" | Branch;
type StudentRoleFilter = "all" | "student" | "admin";
type StudentSort = "newest" | "name" | "role";
type AnnouncementStatusFilter = "all" | "live" | "scheduled" | "draft" | "expired";
type PreviewDevice = "desktop" | "mobile";

interface StudentEnrollmentRow {
  subjectId: string;
  subjectName: string;
  coverageCount: number;
  masteryCount: number;
  totalQuestions: number;
  stagesCompleted: number;
  completedAt?: unknown;
}

const EMPTY_ANNOUNCEMENT: AnnouncementDraft = {
  title: "",
  body: "",
  tone: "info",
  animation: "slide-right",
  font: "default",
  speed: "normal",
  background: "",
  pattern: "none",
  textColor: "",
  loop: true,
  active: true,
  pinned: false,
  publishAt: "",
  expiresAt: "",
};

const TABS: Array<{ id: Tab; label: string; icon: typeof SettingsIcon }> = [
  { id: "overview", label: "نظرة عامة", icon: SparklesIcon },
  { id: "subjects", label: "المواد والمراحل", icon: SettingsIcon },
  { id: "questions", label: "بنك الأسئلة", icon: BookIcon },
  { id: "announcements", label: "الإعلانات", icon: MegaphoneIcon },
  { id: "students", label: "الطلاب", icon: UserIcon },
  { id: "account", label: "أمان الحساب", icon: ShieldIcon },
];

const TONE_OPTIONS: Array<{ value: AnnouncementTone; label: string }> = [
  { value: "info", label: "إعلان عادي" },
  { value: "success", label: "خبر سار" },
  { value: "warning", label: "تنبيه" },
  { value: "danger", label: "هام" },
];

const SUBJECT_PRESETS: Array<{
  id: string;
  label: string;
  description: string;
  settings: Partial<SubjectSettings>;
}> = [
  {
    id: "balanced",
    label: "خطة متوازنة",
    description: "3 جديد + 2 مراجعة، 10 مراحل، فاصل ساعتين.",
    settings: {
      newPerStage: 3,
      reviewPerStage: 2,
      failedNewPerStage: 2,
      failedReviewPerStage: 3,
      passThreshold: 60,
      sessionStages: 10,
      intervalMinutes: 120,
      stageIntervalMinutes: 0,
      wrongIntervalMinutes: 10,
      masteryThreshold: 1,
    },
  },
  {
    id: "recovery",
    label: "تعافٍ مكثف",
    description: "مراجعة أكثر وفاصل أقصر للطلاب المتعثرين.",
    settings: {
      newPerStage: 2,
      reviewPerStage: 4,
      failedNewPerStage: 1,
      failedReviewPerStage: 4,
      passThreshold: 50,
      sessionStages: 8,
      intervalMinutes: 90,
      stageIntervalMinutes: 20,
      wrongIntervalMinutes: 5,
      masteryThreshold: 1,
    },
  },
  {
    id: "fast",
    label: "تقدم سريع",
    description: "جديد أكثر ومراحل أطول لمن يجتاز بثبات.",
    settings: {
      newPerStage: 4,
      reviewPerStage: 1,
      failedNewPerStage: 2,
      failedReviewPerStage: 3,
      passThreshold: 70,
      sessionStages: 12,
      intervalMinutes: 180,
      stageIntervalMinutes: 0,
      wrongIntervalMinutes: 15,
      masteryThreshold: 0.9,
    },
  },
];

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

function dateInputValue(value: unknown): string {
  const millis = toMillis(value);
  if (!millis) return "";
  return new Date(millis).toISOString().slice(0, 10);
}

function dateTimeInputValue(value: unknown): string {
  const millis = toMillis(value);
  if (!millis) return "";
  const local = new Date(millis - new Date(millis).getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function announcementStatus(announcement: Announcement): Exclude<AnnouncementStatusFilter, "all"> {
  const now = Date.now();
  const publish = toMillis(announcement.publishAt);
  const expires = toMillis(announcement.expiresAt);
  if (!announcement.active) return "draft";
  if (publish !== null && publish > now) return "scheduled";
  if (expires !== null && expires <= now) return "expired";
  return isAnnouncementLive(announcement, now) ? "live" : "draft";
}

function announcementStatusLabel(status: Exclude<AnnouncementStatusFilter, "all">): string {
  if (status === "live") return "منشور";
  if (status === "scheduled") return "مجدول";
  if (status === "expired") return "منتهي";
  return "مسودة";
}

function announcementStatusBadge(status: Exclude<AnnouncementStatusFilter, "all">): string {
  if (status === "live") return "badge badge--green";
  if (status === "scheduled") return "badge badge--gold";
  if (status === "expired") return "badge badge--red";
  return "badge badge--soft";
}

function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJson(filename: string, data: unknown): void {
  downloadText(filename, JSON.stringify(data, null, 2), "application/json;charset=utf-8");
}

function csvCell(value: unknown): string {
  let text = String(value ?? "").replace(/\r?\n/g, " ").replace(/"/g, '""');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text}"`;
}

function branchName(branch: Branch): string {
  return branch === "literary" ? "أدبي" : "علمي";
}

function roleBadge(role: "student" | "admin"): string {
  return role === "admin" ? "badge badge--gold" : "badge badge--soft";
}

export function AdminPage() {
  const { profile } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [subjectId, setSubjectId] = useState("");
  const [subjectSettings, setSubjectSettings] = useState<SubjectSettings>(
    DEFAULT_SUBJECT_SETTINGS,
  );
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>(
    DEFAULT_GLOBAL_SETTINGS,
  );
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [students, setStudents] = useState<AdminUserRow[]>([]);
  const [audit, setAudit] = useState<AdminAuditEntry[]>([]);
  const [stats, setStats] = useState<Stats>({
    users: 0,
    questions: 0,
    enrollments: 0,
    attempts: 0,
  });
  const [loading, setLoading] = useState(true);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [studentBranchFilter, setStudentBranchFilter] =
    useState<StudentBranchFilter>("all");
  const [studentRoleFilter, setStudentRoleFilter] = useState<StudentRoleFilter>("all");
  const [studentSort, setStudentSort] = useState<StudentSort>("newest");
  const [studentDetail, setStudentDetail] = useState<AdminUserRow | null>(null);
  const [studentDetailRows, setStudentDetailRows] = useState<StudentEnrollmentRow[]>([]);
  const [studentDetailLoading, setStudentDetailLoading] = useState(false);
  const [announcementFilter, setAnnouncementFilter] =
    useState<AnnouncementStatusFilter>("all");
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>("desktop");
  const [cloneSourceId, setCloneSourceId] = useState("");
  const [draft, setDraft] = useState<AnnouncementDraft>(EMPTY_ANNOUNCEMENT);
  const [previewNonce, setPreviewNonce] = useState(0);
  const announcementEditorRef = useRef<HTMLElement | null>(null);
  const backupInputRef = useRef<HTMLInputElement | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const selectedSubject = useMemo(
    () => subjects.find((subject) => subject.id === subjectId) ?? null,
    [subjects, subjectId],
  );

  const filteredStudents = useMemo(() => {
    const needle = studentSearch.trim().toLowerCase();
    const rows = students.filter((student) => {
      if (studentBranchFilter !== "all" && student.branch !== studentBranchFilter) {
        return false;
      }
      if (studentRoleFilter !== "all" && student.role !== studentRoleFilter) {
        return false;
      }
      if (
        needle &&
        !student.username.toLowerCase().includes(needle) &&
        !student.displayName.toLowerCase().includes(needle)
      ) {
        return false;
      }
      return true;
    });
    return rows.sort((a, b) => {
      if (studentSort === "name") return a.displayName.localeCompare(b.displayName, "ar");
      if (studentSort === "role") {
        if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
        return a.displayName.localeCompare(b.displayName, "ar");
      }
      return (toMillis(b.createdAt) ?? 0) - (toMillis(a.createdAt) ?? 0);
    });
  }, [students, studentSearch, studentBranchFilter, studentRoleFilter, studentSort]);

  const filteredAnnouncements = useMemo(() => {
    if (announcementFilter === "all") return announcements;
    return announcements.filter(
      (announcement) => announcementStatus(announcement) === announcementFilter,
    );
  }, [announcements, announcementFilter]);

  const loadBase = useCallback(async (options?: { silent?: boolean }) => {
    if (!db) return;
    if (!options?.silent) setLoading(true);
    try {
      const [subjectSnap, global, announcementRows, userSnap] = await Promise.all([
        getDocs(query(collection(db, "subjects"), orderBy("sort", "asc"))),
        fetchGlobalSettings(),
        fetchAllAnnouncements(),
        getDocs(query(collection(db, "users"), limit(300))),
      ]);

      setSubjects(
        subjectSnap.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<Subject, "id">),
        })),
      );
      setGlobalSettings(global);
      setAnnouncements(announcementRows);
      setStudents(
        userSnap.docs
          .map((item) => {
            const data = item.data();
            return {
              uid: item.id,
              username: String(data.username ?? ""),
              displayName: String(data.displayName ?? data.username ?? "طالب"),
              branch: data.branch === "literary" ? "literary" : "scientific",
              role: data.role === "admin" ? "admin" : "student",
              createdAt: data.createdAt,
            } as AdminUserRow;
          })
          .sort((a, b) => (toMillis(b.createdAt) ?? 0) - (toMillis(a.createdAt) ?? 0)),
      );

      const [usersCount, questionsCount, enrollmentsCount, attemptsCount] =
        await Promise.allSettled([
          getCountFromServer(collection(db, "users")),
          getCountFromServer(collection(db, "questions")),
          getCountFromServer(collection(db, "enrollments")),
          getCountFromServer(collection(db, "stage_attempts")),
        ]);
      setStats({
        users: usersCount.status === "fulfilled" ? usersCount.value.data().count : userSnap.size,
        questions:
          questionsCount.status === "fulfilled" ? questionsCount.value.data().count : 0,
        enrollments:
          enrollmentsCount.status === "fulfilled"
            ? enrollmentsCount.value.data().count
            : 0,
        attempts:
          attemptsCount.status === "fulfilled" ? attemptsCount.value.data().count : 0,
      });

      const auditSnap = await getDocs(
        query(collection(db, "admin_audit"), orderBy("createdAt", "desc"), limit(12)),
      );
      setAudit(
        auditSnap.docs.map((item) => {
          const data = item.data();
          return {
            id: item.id,
            action: String(data.action ?? ""),
            detail: String(data.detail ?? ""),
            adminUid: String(data.adminUid ?? ""),
            adminName: String(data.adminName ?? ""),
            createdAt: data.createdAt,
          };
        }),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  useEffect(() => {
    if (!subjectId && subjects.length > 0) setSubjectId(subjects[0].id);
  }, [subjectId, subjects]);

  useEffect(() => {
    if (!subjectId) return;
    let active = true;
    setLoadingSettings(true);
    void fetchSubjectSettings(subjectId)
      .then((value) => {
        if (active) setSubjectSettings(value);
      })
      .catch((caught) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoadingSettings(false);
      });
    return () => {
      active = false;
    };
  }, [subjectId]);

  useEffect(() => {
    if (profile?.usernameLower) setNewUsername(profile.usernameLower);
  }, [profile?.usernameLower]);

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 4500);
  }

  async function saveGlobal() {
    if (!profile) return;
    setSaving(true);
    setError("");
    try {
      const saved = await saveGlobalSettings(globalSettings, profile.uid);
      setGlobalSettings(saved);
      applyStudentPalette(saved);
      await logAdminAction(
        profile,
        "settings.global",
        `${saved.stagesLocked ? "إغلاق المراحل" : "فتح المراحل"} • ألوان الطالب ${saved.backgroundColor}/${saved.surfaceColor}/${saved.textColor}/${saved.accentColor} • انتظار ${saved.waitBackgroundColor}/${saved.waitTextColor} • ${
          saved.certificateClaimsEnabled ? "صيغة الشهادة مفعّلة" : "سجل إتمام تدريبي"
        }`,
      );
      showNotice("تم حفظ الإعدادات العامة.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function saveSubject() {
    if (!profile || !subjectId) return;
    setSaving(true);
    setError("");
    try {
      const normalized = normalizeSubjectSettings(subjectSettings);
      const saved = await saveSubjectSettings(subjectId, normalized, profile.uid);
      setSubjectSettings(saved);
      await logAdminAction(
        profile,
        "settings.subject",
        `${selectedSubject?.name ?? subjectId}: ${saved.newPerStage} جديد + ${saved.reviewPerStage} مراجعة، فاصل المراحل ${saved.stageIntervalMinutes} د`,
      );
      showNotice("تم حفظ إعدادات المادة.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  function patchSubject<K extends keyof SubjectSettings>(key: K, value: SubjectSettings[K]) {
    setSubjectSettings((previous) => normalizeSubjectSettings({ ...previous, [key]: value }));
  }

  function applyPalette(palette: StudentPalette) {
    setGlobalSettings((previous) => ({
      ...previous,
      backgroundColor: palette.backgroundColor,
      surfaceColor: palette.surfaceColor,
      textColor: palette.textColor,
      accentColor: palette.accentColor,
      waitBackgroundColor: palette.waitBackgroundColor,
      waitTextColor: palette.waitTextColor,
    }));
  }

  function patchGlobalColor(
    key:
      | "backgroundColor"
      | "surfaceColor"
      | "textColor"
      | "accentColor"
      | "waitBackgroundColor"
      | "waitTextColor",
    value: string,
  ) {
    setGlobalSettings((previous) => ({ ...previous, [key]: value }));
  }

  function contrastBadge(ratio: number) {
    if (ratio >= 7) return { label: "تباين ممتاز", className: "is-good" };
    if (ratio >= 4.5) return { label: "تباين جيد", className: "is-good" };
    if (ratio >= 3) return { label: "تباين محدود", className: "is-warn" };
    return { label: "تباين ضعيف", className: "is-bad" };
  }

  function focusAnnouncementEditor() {
    window.requestAnimationFrame(() => {
      announcementEditorRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  function editAnnouncement(announcement: Announcement) {
    setDraft({
      id: announcement.id,
      title: announcement.title,
      body: announcement.body,
      tone: announcement.tone,
      animation: announcement.animation,
      font: announcement.font,
      speed: announcement.speed,
      background: announcement.background,
      pattern: announcement.pattern,
      textColor: announcement.textColor,
      loop: announcement.loop,
      active: announcement.active,
      pinned: announcement.pinned,
      publishAt: dateTimeInputValue(announcement.publishAt),
      expiresAt: dateInputValue(announcement.expiresAt),
    });
    setPreviewNonce((value) => value + 1);
    setTab("announcements");
    focusAnnouncementEditor();
  }

  function duplicateAnnouncement(announcement: Announcement) {
    setDraft({
      title: `${announcement.title} (نسخة)`,
      body: announcement.body,
      tone: announcement.tone,
      animation: announcement.animation,
      font: announcement.font,
      speed: announcement.speed,
      background: announcement.background,
      pattern: announcement.pattern,
      textColor: announcement.textColor,
      loop: announcement.loop,
      active: false,
      pinned: announcement.pinned,
      publishAt: "",
      expiresAt: "",
    });
    setPreviewNonce((value) => value + 1);
    setTab("announcements");
    focusAnnouncementEditor();
  }

  async function submitAnnouncement(event: FormEvent) {
    event.preventDefault();
    if (!profile) return;
    if (!draft.title.trim() || !draft.body.trim()) {
      setError("اكتب عنوان الإعلان ونصه أولًا.");
      return;
    }
    const publishAt = draft.publishAt ? new Date(draft.publishAt).getTime() : null;
    const expiresAt = draft.expiresAt
      ? new Date(`${draft.expiresAt}T23:59:59`).getTime()
      : null;
    if (publishAt !== null && expiresAt !== null && publishAt >= expiresAt) {
      setError("موعد بدء النشر يجب أن يسبق تاريخ الانتهاء.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await saveAnnouncement(
        {
          id: draft.id,
          title: draft.title,
          body: draft.body,
          tone: draft.tone,
          animation: draft.animation,
          font: draft.font,
          speed: draft.speed,
          background: draft.background,
          pattern: draft.pattern,
          textColor: draft.textColor,
          loop: draft.loop,
          active: draft.active,
          pinned: draft.pinned,
          publishAt,
          expiresAt,
        },
        profile,
      );
      await logAdminAction(
        profile,
        draft.id ? "announcement.update" : "announcement.create",
        draft.title.trim(),
      );
      setDraft(EMPTY_ANNOUNCEMENT);
      setAnnouncements(await fetchAllAnnouncements());
      showNotice(
        !draft.active
          ? "تم حفظ الإعلان كمسودة."
          : publishAt !== null && publishAt > Date.now()
            ? "تم حفظ الإعلان وجدولته للنشر في الموعد المحدد."
            : "تم حفظ الإعلان ونشره للطلاب.",
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function deleteAnnouncementRow(announcement: Announcement) {
    if (!profile) return;
    if (!window.confirm(`حذف إعلان «${announcement.title}» نهائيًا؟`)) return;
    setSaving(true);
    setError("");
    try {
      await removeAnnouncement(announcement.id);
      await logAdminAction(profile, "announcement.delete", announcement.title);
      setAnnouncements(await fetchAllAnnouncements());
      if (draft.id === announcement.id) setDraft(EMPTY_ANNOUNCEMENT);
      showNotice("تم حذف الإعلان.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function toggleRole(student: AdminUserRow) {
    if (!profile || !db) return;
    if (student.uid === profile.uid) {
      setError("لا يمكنك تغيير صلاحية حسابك الحالي من هنا.");
      return;
    }
    const nextRole = student.role === "admin" ? "student" : "admin";
    if (
      !window.confirm(
        nextRole === "admin"
          ? `منح «${student.displayName}» صلاحية مشرف؟`
          : `سحب صلاحية المشرف من «${student.displayName}»؟`,
      )
    ) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      await setDoc(doc(db, "users", student.uid), { role: nextRole }, { merge: true });
      await logAdminAction(profile, "user.role", `${student.username}: ${nextRole}`);
      setStudents((rows) =>
        rows.map((row) => (row.uid === student.uid ? { ...row, role: nextRole } : row)),
      );
      showNotice(nextRole === "admin" ? "تم منح صلاحية المشرف." : "تم سحب صلاحية المشرف.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function showStudentDetails(student: AdminUserRow) {
    setStudentDetail(student);
    setStudentDetailRows([]);
    setStudentDetailLoading(true);
    setError("");
    if (!db) {
      setStudentDetailLoading(false);
      return;
    }
    try {
      const snap = await getDocs(
        query(collection(db, "enrollments"), where("userId", "==", student.uid)),
      );
      setStudentDetailRows(
        snap.docs
          .map((item) => {
            const data = item.data();
            const subjectId = String(data.subjectId ?? "");
            return {
              subjectId,
              subjectName:
                subjects.find((subject) => subject.id === subjectId)?.name ?? subjectId,
              coverageCount: Number(data.coverageCount ?? 0),
              masteryCount: Number(data.masteryCount ?? 0),
              totalQuestions: Number(data.totalQuestions ?? 0),
              stagesCompleted: Number(data.stagesCompleted ?? 0),
              completedAt: data.masteryCompletedAt ?? data.completedAt,
            } satisfies StudentEnrollmentRow;
          })
          .sort((a, b) => a.subjectName.localeCompare(b.subjectName, "ar")),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setStudentDetailLoading(false);
    }
  }

  function exportStudentsCsv() {
    const header = ["الاسم", "اسم المستخدم", "الفرع", "الصلاحية", "تاريخ التسجيل"];
    const lines = filteredStudents.map((student) =>
      [
        student.displayName,
        student.username,
        branchName(student.branch),
        student.role === "admin" ? "مشرف" : "طالب",
        formatDateTime(student.createdAt),
      ].map(csvCell),
    );
    const csv = `\uFEFF${[header.map(csvCell), ...lines].map((row) => row.join(",")).join("\r\n")}`;
    downloadText(
      `students-${new Date().toISOString().slice(0, 10)}.csv`,
      csv,
      "text/csv;charset=utf-8",
    );
    showNotice(`تم تصدير ${formatNumber(filteredStudents.length)} حسابًا.`);
  }

  async function copyUsername(student: AdminUserRow) {
    try {
      await navigator.clipboard.writeText(student.username);
      showNotice(`تم نسخ اسم المستخدم @${student.username}.`);
    } catch {
      setError("تعذر النسخ التلقائي. اسم المستخدم: " + student.username);
    }
  }

  async function toggleSubjectActive() {
    if (!profile || !db || !selectedSubject) return;
    const nextActive = !selectedSubject.active;
    if (
      !window.confirm(
        nextActive
          ? `إظهار مادة «${selectedSubject.name}» للطلاب من جديد؟`
          : `إخفاء مادة «${selectedSubject.name}» عن الطلاب؟ لن يحذف ذلك الأسئلة أو التقدم.`,
      )
    ) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      await setDoc(
        doc(db, "subjects", selectedSubject.id),
        { active: nextActive },
        { merge: true },
      );
      await logAdminAction(
        profile,
        "subject.visibility",
        `${selectedSubject.name}: ${nextActive ? "إظهار" : "إخفاء"}`,
      );
      setSubjects((rows) =>
        rows.map((subject) =>
          subject.id === selectedSubject.id ? { ...subject, active: nextActive } : subject,
        ),
      );
      showNotice(nextActive ? "تم إظهار المادة للطلاب." : "تم إخفاء المادة عن الطلاب.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function moveSubject(direction: -1 | 1) {
    if (!profile || !db) return;
    const index = subjects.findIndex((subject) => subject.id === subjectId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= subjects.length) return;
    const ordered = [...subjects];
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    setSaving(true);
    setError("");
    try {
      const batch = writeBatch(db);
      ordered.forEach((subject, position) => {
        batch.set(
          doc(db!, "subjects", subject.id),
          { sort: position + 1 },
          { merge: true },
        );
      });
      await batch.commit();
      await logAdminAction(
        profile,
        "subject.reorder",
        `ترتيب المواد: ${ordered.map((subject) => subject.name).join(" → ")}`,
      );
      setSubjects(ordered.map((subject, position) => ({ ...subject, sort: position + 1 })));
      showNotice("تم تحديث ترتيب المواد.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  function applySubjectPreset(presetId: string) {
    const preset = SUBJECT_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setSubjectSettings((previous) =>
      normalizeSubjectSettings({
        ...previous,
        ...preset.settings,
      }),
    );
    showNotice(`تم تطبيق «${preset.label}». اضغط حفظ إعدادات المادة لتثبيتها.`);
  }

  async function cloneSubjectSettings() {
    if (!cloneSourceId) {
      setError("اختر المادة التي تريد نسخ إعداداتها.");
      return;
    }
    if (cloneSourceId === subjectId) {
      setError("اختر مادة مختلفة عن المادة الحالية.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const source = subjects.find((subject) => subject.id === cloneSourceId);
      const settings = await fetchSubjectSettings(cloneSourceId);
      setSubjectSettings(settings);
      showNotice(
        `تم نسخ إعدادات «${source?.name ?? cloneSourceId}». راجعها ثم اضغط حفظ إعدادات المادة.`,
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  function resetSubjectSettings() {
    if (!window.confirm("استعادة الإعدادات الافتراضية لهذه المادة؟")) return;
    setSubjectSettings(normalizeSubjectSettings(DEFAULT_SUBJECT_SETTINGS));
    showNotice("تمت استعادة القيم الافتراضية. اضغط حفظ إعدادات المادة لتثبيتها.");
  }

  async function exportAdminBackup() {
    if (!profile) return;
    setSaving(true);
    setError("");
    try {
      const subjectSettingsEntries = await Promise.all(
        subjects.map(async (subject) => ({
          subjectId: subject.id,
          name: subject.name,
          settings: await fetchSubjectSettings(subject.id),
        })),
      );
      const backup = {
        format: "bakaloriastages-admin-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        global: globalSettings,
        subjects: subjects.map((subject) => ({
          id: subject.id,
          name: subject.name,
          active: subject.active,
          sort: subject.sort ?? 0,
          branches: subject.branches,
        })),
        subjectSettings: Object.fromEntries(
          subjectSettingsEntries.map((entry) => [entry.subjectId, entry.settings]),
        ),
      };
      downloadJson(
        `bakaloriastages-backup-${new Date().toISOString().slice(0, 10)}.json`,
        backup,
      );
      await logAdminAction(
        profile,
        "settings.backup.export",
        `${subjects.length} مادة + الإعدادات العامة`,
      );
      showNotice("تم تصدير النسخة الاحتياطية للإعدادات.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function importAdminBackup(file: File | null) {
    if (!file || !profile) return;
    setSaving(true);
    setError("");
    try {
      const parsed = JSON.parse(await file.text()) as {
        format?: string;
        global?: Partial<GlobalSettings>;
        subjectSettings?: Record<string, Partial<SubjectSettings>>;
      };
      if (parsed.format !== "bakaloriastages-admin-backup" || !parsed.global) {
        throw new Error("الملف ليس نسخة احتياطية صالحة من لوحة المدير.");
      }
      const nextGlobal = normalizeGlobalSettings(parsed.global);
      const entries = Object.entries(parsed.subjectSettings ?? {}).filter(([id]) =>
        subjects.some((subject) => subject.id === id),
      );
      if (
        !window.confirm(
          `استيراد الإعدادات العامة و${formatNumber(entries.length)} مادة من النسخة الاحتياطية؟`,
        )
      ) {
        return;
      }
      await saveGlobalSettings(nextGlobal, profile.uid);
      setGlobalSettings(nextGlobal);
      applyStudentPalette(nextGlobal);
      for (const [id, settings] of entries) {
        await saveSubjectSettings(id, normalizeSubjectSettings(settings), profile.uid);
      }
      if (subjectId) {
        setSubjectSettings(await fetchSubjectSettings(subjectId));
      }
      await logAdminAction(
        profile,
        "settings.backup.import",
        `الإعدادات العامة + ${entries.length} مادة`,
      );
      showNotice("تم استيراد النسخة الاحتياطية بنجاح.");
      await loadBase({ silent: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function saveCredentials(event: FormEvent) {
    event.preventDefault();
    if (!profile || !auth?.currentUser?.email) return;
    const username = newUsername.trim().toLowerCase();
    if (!currentPassword) {
      setError("أدخل كلمة المرور الحالية لتأكيد التغيير.");
      return;
    }
    if (username !== profile.usernameLower && !USERNAME_RE.test(username)) {
      setError("اسم المستخدم يجب أن يكون 3–20 حرفًا إنجليزيًا أو أرقامًا أو _.");
      return;
    }
    if (profile.mustChangePassword && username === "admin") {
      setError("اختر اسم مستخدم جديدًا؛ لا يمكن الاحتفاظ بالاسم الافتراضي admin.");
      return;
    }
    if (profile.mustChangePassword && !newPassword) {
      setError("أدخل كلمة مرور جديدة لإكمال تأمين حساب المدير.");
      return;
    }
    if (newPassword && newPassword.length < 6) {
      setError("كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("تأكيد كلمة المرور غير مطابق.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const authUser = auth.currentUser;
      await reauthenticateWithCredential(
        authUser,
        EmailAuthProvider.credential(authUser.email!, currentPassword),
      );

      const oldUsername = profile.usernameLower;

      // Password is the security-critical change, so do it first. Firebase no
      // longer permits silently replacing the synthetic login email (it wants
      // an inbox verification that these internal addresses do not have).
      if (newPassword) {
        await updatePassword(authUser, newPassword);
      }

      if (username !== oldUsername) {
        const newUsernameRef = doc(db!, "usernames", username);
        const existing = await getDoc(newUsernameRef);
        if (existing.exists() && existing.data().uid !== profile.uid) {
          throw new Error("اسم المستخدم محجوز. اختر اسمًا آخر.");
        }
        await runTransaction(db!, async (tx) => {
          const fresh = await tx.get(newUsernameRef);
          if (fresh.exists() && fresh.data().uid !== profile.uid) {
            throw new Error("اسم المستخدم محجوز. اختر اسمًا آخر.");
          }
          const oldUsernameRef = doc(db!, "usernames", oldUsername);
          const oldReservation = await tx.get(oldUsernameRef);
          const storedEmail = oldReservation.exists()
            ? oldReservation.data().email
            : null;
          const loginEmail =
            typeof storedEmail === "string" && storedEmail.includes("@")
              ? storedEmail
              : authUser.email!;
          tx.set(newUsernameRef, {
            uid: profile.uid,
            username,
            // Login resolves the new username to the original Auth email.
            // The Auth email itself stays unchanged because Firebase requires
            // verifying the new address before changing it.
            email: loginEmail,
            createdAt: oldReservation.exists()
              ? (oldReservation.data().createdAt ?? serverTimestamp())
              : serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          tx.delete(oldUsernameRef);
          tx.update(doc(db!, "users", profile.uid), {
            username,
            usernameLower: username,
          });
        });
      }

      await setDoc(
        doc(db!, "users", profile.uid),
        {
          mustChangePassword: false,
          credentialsChangedAt: serverTimestamp(),
        },
        { merge: true },
      );
      await logAdminAction(profile, "admin.credentials", username);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      showNotice("تم تحديث بيانات الدخول. استخدم اسم المستخدم الجديد في المرة القادمة.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  if (!profile) return null;
  if (profile.role !== "admin") return <Navigate to="/" replace />;

  if (loading) {
    return (
      <div className="page">
        <InlineLoader label="نفتح لوحة تحكم الإدارة..." />
      </div>
    );
  }

  const totalQuestionCount = subjects.reduce(
    (sum, subject) => sum + Number(subject.totalQuestions ?? 0),
    0,
  );
  const mustChangePassword = profile.mustChangePassword === true;
  const effectiveTab: Tab = mustChangePassword ? "account" : tab;
  const visibleTabs = mustChangePassword
    ? TABS.filter((item) => item.id === "account")
    : TABS;
  const pageContrast = contrastRatio(globalSettings.textColor, globalSettings.backgroundColor);
  const surfaceContrast = contrastRatio(globalSettings.textColor, globalSettings.surfaceColor);
  const waitContrast = contrastRatio(
    globalSettings.waitTextColor,
    globalSettings.waitBackgroundColor,
  );
  return (
    <div className="page admin-page">
      <section className="admin-hero">
        <div>
          <span className="eyebrow">
            <ShieldIcon />
            لوحة تحكم المدير
          </span>
          <h1>إدارة المنصة من مكان واحد</h1>
          <p>
            أغلق المراحل، انشر الإعلانات، واضبط عدد أسئلة المرحلة والمراجعة، بما في ذلك
            خطة التعافي للطالب الذي لم يتجاوز المرحلة.
          </p>
        </div>
        <div className="admin-hero__badge">
          <span className="user-chip__avatar">{profile.displayName.slice(0, 1)}</span>
          <div>
            <strong>{profile.displayName}</strong>
            <small dir="ltr">@{profile.username}</small>
          </div>
        </div>
      </section>

      {error ? <div className="alert alert--error">{error}</div> : null}
      {notice ? <div className="alert alert--success">{notice}</div> : null}
      {mustChangePassword ? (
        <div className="alert alert--warning">
          <strong>خطوة إلزامية قبل استخدام لوحة التحكم:</strong> أنت تستخدم بيانات الدخول
          الافتراضية. غيّر اسم المستخدم وكلمة المرور الآن، ثم ستُفتح بقية أقسام اللوحة
          تلقائيًا.
        </div>
      ) : null}

      <div className="admin-tabs" role="tablist" aria-label="أقسام لوحة التحكم">
        {visibleTabs.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={effectiveTab === item.id}
              className={effectiveTab === item.id ? "is-active" : ""}
              onClick={() => {
                setTab(item.id);
                setError("");
              }}
            >
              <Icon />
              {item.label}
            </button>
          );
        })}
      </div>

      {effectiveTab === "overview" ? (
        <div className="admin-panel">
          <div className="stats-grid stats-grid--three admin-stats">
            <div className="stat-card">
              <span className="stat-card__label">الطلاب والحسابات</span>
              <strong>{formatNumber(stats.users)}</strong>
              <small>حساب مسجل في المنصة</small>
            </div>
            <div className="stat-card">
              <span className="stat-card__label">بنك الأسئلة</span>
              <strong>{formatNumber(stats.questions || totalQuestionCount)}</strong>
              <small>سؤالًا في {formatNumber(subjects.length)} مواد</small>
            </div>
            <div className="stat-card">
              <span className="stat-card__label">الانضمام للمواد</span>
              <strong>{formatNumber(stats.enrollments)}</strong>
              <small>سجل طالب × مادة</small>
            </div>
            <div className="stat-card">
              <span className="stat-card__label">المراحل المفتوحة والمنتهية</span>
              <strong>{formatNumber(stats.attempts)}</strong>
              <small>محاولة مرحلة مسجلة</small>
            </div>
            <div className="stat-card">
              <span className="stat-card__label">الإعلانات النشطة</span>
              <strong>{formatNumber(announcements.filter((item) => item.active).length)}</strong>
              <small>رسالة ظاهرة للطلاب الآن</small>
            </div>
          </div>

          <div className="admin-split">
            <section className="admin-card">
              <div className="admin-card__heading">
                <div>
                  <span className="eyebrow"><LockIcon /> تحكم سريع</span>
                  <h2>حالة المراحل والتسجيل</h2>
                </div>
                <button
                  className="button button--primary button--sm"
                  type="button"
                  onClick={() => void saveGlobal()}
                  disabled={saving}
                >
                  <CheckIcon />
                  حفظ
                </button>
              </div>

              <label className="admin-switch">
                <input
                  type="checkbox"
                  checked={globalSettings.stagesLocked}
                  onChange={(event) =>
                    setGlobalSettings((previous) => ({
                      ...previous,
                      stagesLocked: event.target.checked,
                    }))
                  }
                />
                <span className="admin-switch__track" />
                <span>
                  <strong>إغلاق فتح المراحل لكل الطلاب</strong>
                  <small>الطلاب الحاليون يستطيعون مراجعة نتائجهم، لكن لا تبدأ مرحلة جديدة.</small>
                </span>
              </label>

              <label className="admin-switch">
                <input
                  type="checkbox"
                  checked={globalSettings.registrationsOpen}
                  onChange={(event) =>
                    setGlobalSettings((previous) => ({
                      ...previous,
                      registrationsOpen: event.target.checked,
                    }))
                  }
                />
                <span className="admin-switch__track" />
                <span>
                  <strong>السماح بإنشاء حسابات جديدة</strong>
                  <small>أوقفه مؤقتًا عند إغلاق التسجيل قبل بداية فصل جديد.</small>
                </span>
              </label>

              <label className="field">
                <span>رسالة تظهر للطلاب عند إغلاق المراحل</span>
                <textarea
                  className="textarea"
                  rows={3}
                  value={globalSettings.lockMessage}
                  onChange={(event) =>
                    setGlobalSettings((previous) => ({
                      ...previous,
                      lockMessage: event.target.value,
                    }))
                  }
                  placeholder="مثال: نعيد ترتيب بنك الأسئلة، تعود المراحل غدًا الساعة 8 صباحًا."
                />
              </label>

              <label className="field">
                <span>رسالة عامة تظهر أعلى الصفحة الرئيسية</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={globalSettings.maintenanceMessage}
                  onChange={(event) =>
                    setGlobalSettings((previous) => ({
                      ...previous,
                      maintenanceMessage: event.target.value,
                    }))
                  }
                  placeholder="مثال: ننصح بمراجعة الوحدة الأولى قبل بدء جلسة اليوم."
                />
                <small>اتركها فارغة لإخفاء التنبيه. تظهر مع الإعلانات النشطة.</small>
              </label>

              <div className="admin-settings-divider">
                <span className="eyebrow"><AwardIcon /> الشهادة والاعتماد</span>
                <p className="muted small">
                  الشهادة الرسمية تحتاج إلى اعتماد من الجهات المختصة. اترك الخيار مغلقًا حتى
                  يصلك الاعتماد، وسيظهر للطلاب سجل إتمام تدريبي فقط.
                </p>
              </div>

              <label className="admin-switch">
                <input
                  type="checkbox"
                  checked={globalSettings.certificateClaimsEnabled}
                  onChange={(event) =>
                    setGlobalSettings((previous) => ({
                      ...previous,
                      certificateClaimsEnabled: event.target.checked,
                    }))
                  }
                />
                <span className="admin-switch__track" />
                <span>
                  <strong>تفعيل صيغة الشهادة بعد الاعتماد</strong>
                  <small>عند الإغلاق تظهر كلمة «سجل إتمام» بدل «شهادة» في واجهة الطالب.</small>
                </span>
              </label>

              <label className="field">
                <span>تنويه الشهادة والاعتماد</span>
                <textarea
                  className="textarea"
                  rows={3}
                  value={globalSettings.certificateNotice}
                  onChange={(event) =>
                    setGlobalSettings((previous) => ({
                      ...previous,
                      certificateNotice: event.target.value,
                    }))
                  }
                  placeholder="وضّح أن الشهادة الرسمية تحتاج إلى اعتماد."
                />
                <small>يظهر أسفل سجل الإتمام وفي صفحة المادة بعد اكتمال المراجعة.</small>
              </label>

              <label className="field">
                <span>تذكير الامتحان الأخير</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={globalSettings.finalExamReminder}
                  onChange={(event) =>
                    setGlobalSettings((previous) => ({
                      ...previous,
                      finalExamReminder: event.target.value,
                    }))
                  }
                  placeholder="تذكير للطلاب الذين اقتربوا من النجاح في امتحان الشهادة الأخير."
                />
                <small>يظهر في الرئيسية وعند اكتمال مراجعة المادة.</small>
              </label>

              <div className="admin-settings-divider">
                <span className="eyebrow"><SparklesIcon /> ألوان صفحة الطالب</span>
                <p className="muted small">
                  اختر لوحة جاهزة أو عدّل ألوان الصفحة والبطاقات والنص والتمييز. تُطبَّق
                  الألوان على كل صفحات الطالب بعد الحفظ. يمكنك ضبط شاشة الانتظار في
                  القسم التالي.
                </p>
              </div>

              <div className="palette-presets">
                {STUDENT_PALETTES.map((palette) => {
                  const selected = paletteMatches(globalSettings, palette);
                  return (
                    <button
                      key={palette.id}
                      type="button"
                      className={`palette-preset${selected ? " is-selected" : ""}`}
                      onClick={() => applyPalette(palette)}
                      aria-pressed={selected}
                    >
                      <span className="palette-preset__dots" aria-hidden="true">
                        <i style={{ backgroundColor: palette.backgroundColor }} />
                        <i style={{ backgroundColor: palette.surfaceColor }} />
                        <i style={{ backgroundColor: palette.accentColor }} />
                      </span>
                      <span className="palette-preset__body">
                        <strong>{palette.label}</strong>
                        <small>{palette.description}</small>
                      </span>
                      {selected ? <CheckIcon /> : null}
                    </button>
                  );
                })}
              </div>

              <div className="student-color-grid">
                {([
                  {
                    key: "backgroundColor",
                    label: "خلفية الصفحة",
                    hint: "اللون العام خلف كل البطاقات.",
                  },
                  {
                    key: "surfaceColor",
                    label: "خلفية البطاقات",
                    hint: "البطاقات والجداول والنوافذ.",
                  },
                  {
                    key: "textColor",
                    label: "لون النص",
                    hint: "العناوين والنصوص الأساسية.",
                  },
                  {
                    key: "accentColor",
                    label: "لون التمييز",
                    hint: "الأزرار والروابط والعناصر المهمة.",
                  },
                ] as const).map((item) => (
                  <label className="field" key={item.key}>
                    <span>{item.label}</span>
                    <div className="admin-inline-color">
                      <input
                        className="admin-color-input"
                        type="color"
                        value={globalSettings[item.key]}
                        onChange={(event) => patchGlobalColor(item.key, event.target.value)}
                      />
                      <code className="admin-color-code" dir="ltr">
                        {globalSettings[item.key].toUpperCase()}
                      </code>
                    </div>
                    <small>{item.hint}</small>
                  </label>
                ))}
              </div>

              <div className="field">
                <span>لوحة ألوان سريعة للخلفية</span>
                <div className="theme-swatches">
                  {BACKGROUND_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      className={`theme-swatch${
                        globalSettings.backgroundColor === preset.value ? " is-selected" : ""
                      }`}
                      style={{ backgroundColor: preset.value }}
                      title={preset.label}
                      aria-label={preset.label}
                      onClick={() => patchGlobalColor("backgroundColor", preset.value)}
                    />
                  ))}
                  <label className="theme-swatch theme-swatch--custom" title="لون مخصص">
                    <input
                      type="color"
                      value={globalSettings.backgroundColor}
                      onChange={(event) => patchGlobalColor("backgroundColor", event.target.value)}
                    />
                    <span>+</span>
                  </label>
                </div>
              </div>

              <div className="admin-settings-divider">
                <span className="eyebrow"><LockIcon /> شاشة الانتظار بين المراحل</span>
                <p className="muted small">
                  هذه الشاشة تظهر عند الانتظار بين مرحلتين أو عند إغلاق المراحل من الإدارة.
                  عيّن خلفيتها ونصها مباشرة؛ حلّل التباين قبل الحفظ.
                </p>
              </div>

              <div className="student-color-grid">
                {([
                  {
                    key: "waitBackgroundColor",
                    label: "خلفية شاشة الانتظار",
                    hint: "اللون الغامق الذي تظهر عليه رسالة الانتظار.",
                  },
                  {
                    key: "waitTextColor",
                    label: "نص شاشة الانتظار",
                    hint: "لون العنوان والفقرة والعدّاد.",
                  },
                ] as const).map((item) => (
                  <label className="field" key={item.key}>
                    <span>{item.label}</span>
                    <div className="admin-inline-color">
                      <input
                        className="admin-color-input"
                        type="color"
                        value={globalSettings[item.key]}
                        onChange={(event) => patchGlobalColor(item.key, event.target.value)}
                      />
                      <code className="admin-color-code" dir="ltr">
                        {globalSettings[item.key].toUpperCase()}
                      </code>
                    </div>
                    <small>{item.hint}</small>
                  </label>
                ))}
              </div>

              <div
                className="student-palette-preview"
                style={{
                  backgroundColor: globalSettings.backgroundColor,
                  color: globalSettings.textColor,
                }}
              >
                <div className="student-palette-preview__head">
                  <strong>معاينة مباشرة لصفحة الطالب</strong>
                  <span className={`contrast-badge ${contrastBadge(pageContrast).className}`}>
                    {contrastBadge(pageContrast).label}
                  </span>
                </div>
                <p>هكذا سيظهر النص العادي على خلفية الصفحة.</p>
                <div
                  className="student-palette-preview__card"
                  style={{
                    backgroundColor: globalSettings.waitBackgroundColor,
                    color: globalSettings.waitTextColor,
                    borderColor: "rgba(128, 128, 128, 0.35)",
                  }}
                >
                  <span
                    className="student-palette-preview__eyebrow"
                    style={{ color: globalSettings.waitTextColor }}
                  >
                    فاصل بين المراحل
                  </span>
                  <strong>استراحة قصيرة بين المراحل</strong>
                  <p>المرحلة التالية تبدأ بعد:</p>
                  <span
                    className="student-palette-preview__countdown"
                    style={{
                      backgroundColor: "rgba(128, 128, 128, 0.22)",
                      color: globalSettings.waitTextColor,
                    }}
                  >
                    12:00
                  </span>
                </div>
              </div>

              <div className="contrast-row">
                <span className={`contrast-badge ${contrastBadge(pageContrast).className}`}>
                  النص على خلفية الصفحة: {pageContrast.toFixed(1)}:1
                </span>
                <span className={`contrast-badge ${contrastBadge(surfaceContrast).className}`}>
                  النص على البطاقات: {surfaceContrast.toFixed(1)}:1
                </span>
                <span className={`contrast-badge ${contrastBadge(waitContrast).className}`}>
                  نص الانتظار: {waitContrast.toFixed(1)}:1
                </span>
                <button
                  type="button"
                  className="button button--ghost button--sm"
                  onClick={() => applyPalette(STUDENT_PALETTES[0])}
                >
                  <RefreshIcon />
                  استعادة الافتراضي
                </button>
              </div>
              <small>
                إذا ظهر «تباين ضعيف» فاختر نصًا أفتح مع الخلفيات الداكنة، أو نصًا أغمق مع
                الخلفيات الفاتحة. شاشة الانتظار تستخدم نصوصًا فاتحة دائمًا فوق خلفيتها الداكنة.
              </small>
            </section>

            <section className="admin-card">
              <div className="admin-card__heading">
                <div>
                  <span className="eyebrow"><BellIcon /> آخر إجراءات الإدارة</span>
                  <h2>سجل مختصر</h2>
                </div>
              </div>
              {audit.length === 0 ? (
                <p className="muted small">ستظهر هنا آخر التعديلات التي تجريها.</p>
              ) : (
                <ul className="audit-list">
                  {audit.map((entry) => (
                    <li key={entry.id}>
                      <span className="audit-list__dot" />
                      <div>
                        <strong>{entry.detail || entry.action}</strong>
                        <small>
                          {entry.adminName} • {formatDateTime(entry.createdAt)}
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="admin-quick-grid">
            <button type="button" className="admin-quick" onClick={() => setTab("subjects")}>
              <SettingsIcon />
              <strong>إعدادات كل مادة</strong>
              <span>عدد الجديد والمراجعة وخطة الفشل</span>
            </button>
            <button type="button" className="admin-quick" onClick={() => setTab("announcements")}>
              <MegaphoneIcon />
              <strong>نشر إعلان</strong>
              <span>رسالة تظهر في الرئيسية ومركز الإشعارات</span>
            </button>
            <button type="button" className="admin-quick" onClick={() => setTab("questions")}>
              <BookIcon />
              <strong>بنك الأسئلة</strong>
              <span>إضافة فردية أو دفعة واستيراد JSON</span>
            </button>
            <button type="button" className="admin-quick" onClick={() => setTab("students")}>
              <UserIcon />
              <strong>إدارة الطلاب</strong>
              <span>بحث ومنح صلاحية مشرف</span>
            </button>
            <button type="button" className="admin-quick" onClick={() => setTab("account")}>
              <ShieldIcon />
              <strong>تغيير بيانات الدخول</strong>
              <span>اسم المستخدم وكلمة المرور</span>
            </button>
          </div>

          <section className="admin-card admin-backup">
            <div className="admin-card__heading">
              <div>
                <span className="eyebrow"><ShieldIcon /> النسخ الاحتياطي</span>
                <h2>إعدادات المنصة والمواد</h2>
                <p className="muted small">
                  صدّر نسخة JSON من الإعدادات العامة وإعدادات كل المواد، أو استعدها على
                  جهاز آخر. لا تتضمن النسخة حسابات الطلاب أو كلمات المرور.
                </p>
              </div>
              <div className="button-row">
                <button
                  className="button button--primary button--sm"
                  type="button"
                  onClick={() => void exportAdminBackup()}
                  disabled={saving}
                >
                  تصدير نسخة
                </button>
                <button
                  className="button button--ghost button--sm"
                  type="button"
                  onClick={() => backupInputRef.current?.click()}
                  disabled={saving}
                >
                  استيراد نسخة
                </button>
                <input
                  ref={backupInputRef}
                  className="hidden-file"
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => {
                    void importAdminBackup(event.target.files?.[0] ?? null);
                    event.target.value = "";
                  }}
                />
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {effectiveTab === "subjects" ? (
        <div className="admin-panel">
          <section className="admin-card">
            <div className="admin-card__heading">
              <div>
                <span className="eyebrow"><BookIcon /> إعدادات المواد</span>
                <h2>عدد أسئلة المرحلة والمراجعة</h2>
              </div>
              <div className="admin-inline">
                <select
                  className="input admin-select"
                  value={subjectId}
                  onChange={(event) => setSubjectId(event.target.value)}
                >
                  {subjects.map((subject) => (
                    <option value={subject.id} key={subject.id}>
                      {subject.name}
                    </option>
                  ))}
                </select>
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => void saveSubject()}
                  disabled={saving || loadingSettings || !subjectId}
                >
                  <CheckIcon />
                  حفظ إعدادات المادة
                </button>
              </div>
            </div>

            {selectedSubject ? (
              <>
                <div className="admin-subject-toolbar">
                  <div className="admin-subject-presets">
                    {SUBJECT_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        className="admin-preset"
                        type="button"
                        title={preset.description}
                        onClick={() => applySubjectPreset(preset.id)}
                        disabled={saving}
                      >
                        <strong>{preset.label}</strong>
                        <small>{preset.description}</small>
                      </button>
                    ))}
                  </div>
                  <div className="admin-inline admin-subject-copy">
                    <select
                      className="input admin-select"
                      value={cloneSourceId}
                      onChange={(event) => setCloneSourceId(event.target.value)}
                      aria-label="المادة المصدر لنسخ الإعدادات"
                    >
                      <option value="">نسخ إعدادات من مادة...</option>
                      {subjects
                        .filter((subject) => subject.id !== subjectId)
                        .map((subject) => (
                          <option value={subject.id} key={subject.id}>
                            {subject.name}
                          </option>
                        ))}
                    </select>
                    <button
                      className="button button--ghost button--sm"
                      type="button"
                      onClick={() => void cloneSubjectSettings()}
                      disabled={saving || !cloneSourceId}
                    >
                      نسخ
                    </button>
                    <button
                      className="button button--ghost button--sm"
                      type="button"
                      onClick={resetSubjectSettings}
                      disabled={saving}
                    >
                      <RefreshIcon />
                      استعادة الافتراضي
                    </button>
                  </div>
                </div>

                <div className="admin-subject-visibility">
                  <span
                    className={selectedSubject.active ? "badge badge--green" : "badge badge--red"}
                  >
                    {selectedSubject.active ? "ظاهرة للطلاب" : "مخفية عن الطلاب"}
                  </span>
                  <button
                    className="button button--ghost button--sm"
                    type="button"
                    onClick={() => void toggleSubjectActive()}
                    disabled={saving}
                  >
                    {selectedSubject.active ? "إخفاء المادة" : "إظهار المادة"}
                  </button>
                  <button
                    className="button button--ghost button--sm"
                    type="button"
                    onClick={() => void moveSubject(-1)}
                    disabled={saving || subjects.findIndex((subject) => subject.id === subjectId) <= 0}
                  >
                    تقديم
                  </button>
                  <button
                    className="button button--ghost button--sm"
                    type="button"
                    onClick={() => void moveSubject(1)}
                    disabled={
                      saving ||
                      subjects.findIndex((subject) => subject.id === subjectId) >=
                        subjects.length - 1
                    }
                  >
                    تأخير
                  </button>
                </div>
              </>
            ) : null}

            {loadingSettings ? (
              <InlineLoader label="نقرأ إعدادات المادة..." />
            ) : (
              <>
                <div className="admin-formula">
                  <div>
                    <span>المرحلة العادية</span>
                    <strong>
                      {formatNumber(subjectSettings.newPerStage)} جديد +{" "}
                      {formatNumber(subjectSettings.reviewPerStage)} مراجعة ={" "}
                      {formatNumber(subjectSettings.stageSize)} أسئلة
                    </strong>
                  </div>
                  <div className="admin-formula__recovery">
                    <span>بعد رسوب الطالب</span>
                    <strong>
                      {formatNumber(subjectSettings.failedNewPerStage)} جديد +{" "}
                      {formatNumber(subjectSettings.failedReviewPerStage)} مراجعة
                    </strong>
                  </div>
                </div>

                <div className="admin-field-grid">
                  <label className="field">
                    <span>أسئلة جديدة في المرحلة</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={10}
                      value={subjectSettings.newPerStage}
                      onChange={(event) =>
                        patchSubject("newPerStage", Number(event.target.value))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>أسئلة مراجعة في المرحلة</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={10}
                      value={subjectSettings.reviewPerStage}
                      onChange={(event) =>
                        patchSubject("reviewPerStage", Number(event.target.value))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>جديد بعد رسوب المرحلة</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={10}
                      value={subjectSettings.failedNewPerStage}
                      onChange={(event) =>
                        patchSubject("failedNewPerStage", Number(event.target.value))
                      }
                    />
                    <small>أقل من العادي: يركز على التعافي بدل التقدم السريع.</small>
                  </label>
                  <label className="field">
                    <span>مراجعة بعد رسوب المرحلة</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={10}
                      value={subjectSettings.failedReviewPerStage}
                      onChange={(event) =>
                        patchSubject("failedReviewPerStage", Number(event.target.value))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>حد النجاح في المرحلة (%)</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={100}
                      value={subjectSettings.passThreshold}
                      onChange={(event) =>
                        patchSubject("passThreshold", Number(event.target.value))
                      }
                    />
                    <small>أقل من هذه النسبة يعتبر رسوبًا ويطبق خطة التعافي.</small>
                  </label>
                  <label className="field">
                    <span>مراحل الجلسة</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={50}
                      value={subjectSettings.sessionStages}
                      onChange={(event) =>
                        patchSubject("sessionStages", Number(event.target.value))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>الفاصل بين الجلسات (دقيقة)</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={10080}
                      value={subjectSettings.intervalMinutes}
                      onChange={(event) =>
                        patchSubject("intervalMinutes", Number(event.target.value))
                      }
                    />
                    <small>يُستخدم أيضًا كأساس لجدولة المراجعة المتباعدة.</small>
                  </label>
                  <label className="field">
                    <span>الفاصل بين المراحل (دقيقة)</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={10080}
                      value={subjectSettings.stageIntervalMinutes}
                      onChange={(event) =>
                        patchSubject("stageIntervalMinutes", Number(event.target.value))
                      }
                    />
                    <small>0 = بدون فاصل. يبدأ بعد تأكيد الاطلاع على الإجابات النموذجية.</small>
                  </label>
                  <label className="field">
                    <span>عودة السؤال الخاطئ بعد (دقيقة)</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={10080}
                      value={subjectSettings.wrongIntervalMinutes}
                      onChange={(event) =>
                        patchSubject("wrongIntervalMinutes", Number(event.target.value))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>هدف الإتقان (%)</span>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={100}
                      value={Math.round(subjectSettings.masteryThreshold * 100)}
                      onChange={(event) =>
                        patchSubject(
                          "masteryThreshold",
                          Math.max(0, Math.min(1, Number(event.target.value) / 100)),
                        )
                      }
                    />
                    <small>100% تعني إتقان كل أسئلة المادة قبل سجل الإتمام.</small>
                  </label>
                </div>

                <div className="admin-toggle-row">
                  <label className="admin-switch">
                    <input
                      type="checkbox"
                      checked={subjectSettings.stagesLocked}
                      onChange={(event) =>
                        patchSubject("stagesLocked", event.target.checked)
                      }
                    />
                    <span className="admin-switch__track" />
                    <span>
                      <strong>إغلاق هذه المادة فقط</strong>
                      <small>لا يؤثر على بقية المواد.</small>
                    </span>
                  </label>
                  <label className="admin-switch">
                    <input
                      type="checkbox"
                      checked={subjectSettings.finalExamRequired}
                      onChange={(event) =>
                        patchSubject("finalExamRequired", event.target.checked)
                      }
                    />
                    <span className="admin-switch__track" />
                    <span>
                      <strong>اشتراط الامتحان الختامي</strong>
                      <small>شرط إضافي قبل اعتماد سجل الإتمام النهائي.</small>
                    </span>
                  </label>
                </div>

                <label className="field">
                  <span>رسالة إغلاق خاصة بهذه المادة</span>
                  <textarea
                    className="textarea"
                    rows={2}
                    value={subjectSettings.lockMessage}
                    onChange={(event) => patchSubject("lockMessage", event.target.value)}
                    placeholder="اتركها فارغة لاستخدام رسالة الإغلاق العامة."
                  />
                </label>
              </>
            )}
          </section>
        </div>
      ) : null}

      {effectiveTab === "questions" ? (
        <QuestionBankPanel
          subjects={subjects}
          profile={profile}
          onChanged={() => void loadBase({ silent: true })}
        />
      ) : null}

      {effectiveTab === "announcements" ? (
        <div className="admin-panel admin-split admin-split--announcements">
          <section className="admin-card announcement-editor" ref={announcementEditorRef}>
            <div className="admin-card__heading">
              <div>
                <span className="eyebrow"><MegaphoneIcon /> رسالة جديدة</span>
                <h2>{draft.id ? "تعديل إعلان" : "نشر للطلاب"}</h2>
              </div>
              {draft.id ? (
                <button
                  className="button button--ghost button--sm"
                  type="button"
                  onClick={() => setDraft(EMPTY_ANNOUNCEMENT)}
                >
                  <XIcon />
                  إلغاء التعديل
                </button>
              ) : null}
            </div>

            <form className="form" onSubmit={submitAnnouncement}>
              <label className="field">
                <span>عنوان الإعلان</span>
                <input
                  className="input"
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((previous) => ({ ...previous, title: event.target.value }))
                  }
                  maxLength={80}
                  required
                />
              </label>
              <label className="field">
                <span>نص الرسالة</span>
                <textarea
                  className="textarea"
                  rows={5}
                  value={draft.body}
                  onChange={(event) =>
                    setDraft((previous) => ({ ...previous, body: event.target.value }))
                  }
                  maxLength={1200}
                  required
                />
              </label>
              <div className="admin-field-grid">
                <label className="field">
                  <span>نوع الرسالة</span>
                  <select
                    className="input"
                    value={draft.tone}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        tone: event.target.value as AnnouncementTone,
                      }))
                    }
                  >
                    {TONE_OPTIONS.map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>تاريخ الانتهاء (اختياري)</span>
                  <input
                    className="input"
                    type="date"
                    value={draft.expiresAt}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        expiresAt: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="field">
                  <span>بدء النشر (اختياري)</span>
                  <input
                    className="input"
                    type="datetime-local"
                    value={draft.publishAt}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        publishAt: event.target.value,
                      }))
                    }
                  />
                  <small>اتركه فارغًا للنشر فورًا، أو حدّد موعدًا ليظهر تلقائيًا.</small>
                </label>
                <label className="field">
                  <span>حركة الإعلان</span>
                  <select
                    className="input"
                    value={draft.animation}
                    onChange={(event) => {
                      const animation = event.target.value as AnnouncementAnimation;
                      setDraft((previous) => ({
                        ...previous,
                        animation,
                        loop: animation === "banner" ? true : previous.loop,
                      }));
                    }}
                  >
                    {ANNOUNCEMENT_ANIMATIONS.map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label} — {option.description}
                      </option>
                    ))}
                  </select>
                  <small>
                    {draft.animation === "banner"
                      ? "البانر يثبت الإطار ويجعل النص يتحرك داخله فقط، ويستمر تلقائيًا."
                      : "تتحرك بطاقة الإعلان كاملة حسب الحركة المختارة."}
                  </small>
                </label>
                <label className="field">
                  <span>خط الإعلان</span>
                  <select
                    className="input"
                    value={draft.font}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        font: event.target.value as AnnouncementFont,
                      }))
                    }
                  >
                    {ANNOUNCEMENT_FONTS.map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label} — {option.sample}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>سرعة الحركة</span>
                  <select
                    className="input"
                    value={draft.speed}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        speed: event.target.value as AnnouncementSpeed,
                      }))
                    }
                  >
                    {ANNOUNCEMENT_SPEEDS.map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>زخرفة الخلفية</span>
                  <select
                    className="input"
                    value={draft.pattern}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        pattern: event.target.value as AnnouncementPattern,
                      }))
                    }
                  >
                    {ANNOUNCEMENT_PATTERNS.map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>لون النص</span>
                  <div className="admin-inline-color">
                    <input
                      className="input admin-color-input"
                      type="color"
                      value={draft.textColor || "#122a28"}
                      onChange={(event) =>
                        setDraft((previous) => ({ ...previous, textColor: event.target.value }))
                      }
                    />
                    <button
                      className="button button--ghost button--sm"
                      type="button"
                      onClick={() =>
                        setDraft((previous) => ({ ...previous, textColor: "" }))
                      }
                    >
                      تلقائي
                    </button>
                  </div>
                  <small>اتركه تلقائيًا لاختيار لون مقروء حسب الخلفية.</small>
                </label>
              </div>

              <div className="field">
                <span>خلفية الإعلان</span>
                <div className="theme-swatches">
                  {ANNOUNCEMENT_BACKGROUNDS.map((preset) => (
                    <button
                      key={preset.value || "default"}
                      type="button"
                      className={`theme-swatch theme-swatch--announcement${
                        draft.background === preset.value ? " is-selected" : ""
                      }`}
                      style={{
                        backgroundColor: preset.value || undefined,
                        backgroundImage: preset.value
                          ? undefined
                          : "linear-gradient(135deg, #fffdf9, #f1ece1)",
                      }}
                      title={preset.label}
                      aria-label={preset.label}
                      onClick={() =>
                        setDraft((previous) => ({
                          ...previous,
                          background: preset.value,
                        }))
                      }
                    />
                  ))}
                  <label className="theme-swatch theme-swatch--custom" title="لون خلفية مخصص">
                    <input
                      type="color"
                      value={draft.background || "#fffaf0"}
                      onChange={(event) =>
                        setDraft((previous) => ({
                          ...previous,
                          background: event.target.value,
                        }))
                      }
                    />
                    <span>+</span>
                  </label>
                </div>
                <small>الخلفيات الداكنة تحوّل النص تلقائيًا إلى الأبيض ما لم تختر لونًا يدويًا.</small>
              </div>

              {draft.animation === "banner" ? (
                <p className="muted small">
                  البانر يحرّك النص داخل شريط ثابت ويستمر تلقائيًا. استخدم سرعة الحركة
                  للتحكم في وتيرته.
                </p>
              ) : (
                <div className="admin-toggle-row">
                  <label className="admin-switch admin-switch--compact">
                    <input
                      type="checkbox"
                      checked={draft.loop}
                      onChange={(event) =>
                        setDraft((previous) => ({ ...previous, loop: event.target.checked }))
                      }
                    />
                    <span className="admin-switch__track" />
                    <span>
                      <strong>حركة مستمرة</strong>
                      <small>تُبقي الإعلان متحركًا بدل تشغيل الحركة مرة واحدة.</small>
                    </span>
                  </label>
                </div>
              )}

              <div className="announcement-preview">
                <div className="announcement-preview__head">
                  <span className="eyebrow"><SparklesIcon /> معاينة مباشرة</span>
                  <div className="announcement-preview__actions">
                    <div
                      className="announcement-preview__devices"
                      role="group"
                      aria-label="حجم معاينة الإعلان"
                    >
                      <button
                        className={`button button--ghost button--sm${
                          previewDevice === "desktop" ? " is-active" : ""
                        }`}
                        type="button"
                        aria-pressed={previewDevice === "desktop"}
                        onClick={() => setPreviewDevice("desktop")}
                      >
                        سطح المكتب
                      </button>
                      <button
                        className={`button button--ghost button--sm${
                          previewDevice === "mobile" ? " is-active" : ""
                        }`}
                        type="button"
                        aria-pressed={previewDevice === "mobile"}
                        onClick={() => setPreviewDevice("mobile")}
                      >
                        الهاتف
                      </button>
                    </div>
                    <button
                      className="button button--ghost button--sm"
                      type="button"
                      onClick={() => setPreviewNonce((value) => value + 1)}
                    >
                      <RefreshIcon />
                      إعادة الحركة
                    </button>
                  </div>
                </div>
                <div
                  className={`announcement-preview__surface${
                    previewDevice === "mobile"
                      ? " announcement-preview__surface--mobile"
                      : ""
                  }`}
                >
                  <article
                    className={announcementClasses({
                      tone: draft.tone,
                      animation: draft.animation,
                      font: draft.font,
                      speed: draft.speed,
                      pattern: draft.pattern,
                      background: draft.background,
                      loop: draft.loop,
                    })}
                    style={announcementStyle(draft)}
                    key={`${previewNonce}-${draft.animation}-${draft.speed}-${draft.font}-${draft.pattern}-${draft.background}-${draft.textColor}-${draft.loop}`}
                  >
                    <span className="notice__icon"><MegaphoneIcon /></span>
                    <AnnouncementContent
                      title={draft.title || "عنوان الإعلان"}
                      body={draft.body || "سيظهر نص رسالتك هنا بالحركة والخط المختارين."}
                      banner={draft.animation === "banner"}
                    />
                  </article>
                </div>
              </div>

              <div className="admin-toggle-row">
                <label className="admin-switch admin-switch--compact">
                  <input
                    type="checkbox"
                    checked={draft.active}
                    onChange={(event) =>
                      setDraft((previous) => ({ ...previous, active: event.target.checked }))
                    }
                  />
                  <span className="admin-switch__track" />
                  <span><strong>منشور الآن</strong></span>
                </label>
                <label className="admin-switch admin-switch--compact">
                  <input
                    type="checkbox"
                    checked={draft.pinned}
                    onChange={(event) =>
                      setDraft((previous) => ({ ...previous, pinned: event.target.checked }))
                    }
                  />
                  <span className="admin-switch__track" />
                  <span><strong>مثبّت في الأعلى</strong></span>
                </label>
              </div>
              <button
                className="button button--primary button--lg button--block"
                type="submit"
                disabled={saving}
              >
                <MegaphoneIcon />
                {draft.id ? "حفظ التعديلات" : "نشر الإعلان"}
              </button>
            </form>
          </section>

          <section className="admin-card">
            <div className="admin-card__heading">
              <div>
                <span className="eyebrow"><BellIcon /> سجل الإعلانات</span>
                <h2>
                  {formatNumber(filteredAnnouncements.length)} من{" "}
                  {formatNumber(announcements.length)} رسالة
                </h2>
              </div>
              <div className="admin-inline admin-announcement-filters">
                <select
                  className="input admin-select"
                  value={announcementFilter}
                  onChange={(event) =>
                    setAnnouncementFilter(event.target.value as AnnouncementStatusFilter)
                  }
                  aria-label="تصفية الإعلانات حسب الحالة"
                >
                  <option value="all">كل الحالات</option>
                  <option value="live">منشور الآن</option>
                  <option value="scheduled">مجدول</option>
                  <option value="draft">مسودة</option>
                  <option value="expired">منتهي</option>
                </select>
                <button
                  className="button button--ghost button--sm"
                  type="button"
                  onClick={() => void loadBase()}
                  disabled={saving}
                >
                  <RefreshIcon />
                  تحديث
                </button>
              </div>
            </div>
            {announcements.length === 0 ? (
              <p className="muted">لا توجد إعلانات بعد.</p>
            ) : filteredAnnouncements.length === 0 ? (
              <p className="muted">لا توجد إعلانات مطابقة للحالة المختارة.</p>
            ) : (
              <div className="admin-announcement-list">
                {filteredAnnouncements.map((announcement) => (
                  <article className="admin-announcement" key={announcement.id}>
                    <div className="admin-announcement__top">
                      <span className={announcementStatusBadge(announcementStatus(announcement))}>
                        {announcementStatusLabel(announcementStatus(announcement))}
                      </span>
                      {announcement.pinned ? <span className="badge badge--gold">مثبّت</span> : null}
                      <span className="badge badge--soft">
                        {ANNOUNCEMENT_ANIMATIONS.find(
                          (item) => item.value === announcement.animation,
                        )?.label ?? "بدون حركة"}
                      </span>
                      <span className="badge badge--soft">
                        {ANNOUNCEMENT_FONTS.find((item) => item.value === announcement.font)?.label ??
                          "الخط الافتراضي"}
                      </span>
                      <span className="badge badge--soft">
                        {ANNOUNCEMENT_SPEEDS.find((item) => item.value === announcement.speed)
                          ?.label ?? "متوسطة"}
                      </span>
                      {announcement.loop ? (
                        <span className="badge badge--green">مستمرة</span>
                      ) : null}
                      {announcement.background || announcement.pattern !== "none" ? (
                        <span className="badge badge--gold">خلفية مزخرفة</span>
                      ) : null}
                      <span className="muted small">{formatDateTime(announcement.createdAt)}</span>
                      {announcement.publishAt ? (
                        <span className="muted small">
                          يبدأ {formatDateTime(announcement.publishAt)}
                        </span>
                      ) : null}
                    </div>
                    <h3>{announcement.title}</h3>
                    <p>{announcement.body}</p>
                    <div className="button-row">
                      <button
                        className="button button--ghost button--sm"
                        type="button"
                        onClick={() => editAnnouncement(announcement)}
                      >
                        تعديل
                      </button>
                      <button
                        className="button button--ghost button--sm"
                        type="button"
                        onClick={() => duplicateAnnouncement(announcement)}
                      >
                        نسخ
                      </button>
                      <button
                        className="button button--danger-ghost button--sm"
                        type="button"
                        onClick={() => void deleteAnnouncementRow(announcement)}
                      >
                        <TrashIcon />
                        حذف
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}

      {effectiveTab === "students" ? (
        <div className="admin-panel">
          <section className="admin-card">
            <div className="admin-card__heading">
              <div>
                <span className="eyebrow"><TrophyIcon /> الطلاب</span>
                <h2>الحسابات والصلاحيات</h2>
              </div>
              <div className="admin-inline admin-student-tools">
                <input
                  className="input admin-search"
                  value={studentSearch}
                  onChange={(event) => setStudentSearch(event.target.value)}
                  placeholder="ابحث باسم المستخدم أو الاسم الظاهر..."
                />
                <button
                  className="button button--ghost button--sm"
                  type="button"
                  onClick={exportStudentsCsv}
                >
                  تصدير CSV
                </button>
              </div>
            </div>
            <div className="admin-field-grid admin-student-filters">
              <label className="field">
                <span>الفرع</span>
                <select
                  className="input"
                  value={studentBranchFilter}
                  onChange={(event) =>
                    setStudentBranchFilter(event.target.value as StudentBranchFilter)
                  }
                >
                  <option value="all">كل الفروع</option>
                  <option value="scientific">علمي</option>
                  <option value="literary">أدبي</option>
                </select>
              </label>
              <label className="field">
                <span>الصلاحية</span>
                <select
                  className="input"
                  value={studentRoleFilter}
                  onChange={(event) =>
                    setStudentRoleFilter(event.target.value as StudentRoleFilter)
                  }
                >
                  <option value="all">الكل</option>
                  <option value="student">طلاب</option>
                  <option value="admin">مشرفون</option>
                </select>
              </label>
              <label className="field">
                <span>الترتيب</span>
                <select
                  className="input"
                  value={studentSort}
                  onChange={(event) => setStudentSort(event.target.value as StudentSort)}
                >
                  <option value="newest">الأحدث تسجيلًا</option>
                  <option value="name">الاسم أبجديًا</option>
                  <option value="role">الصلاحية ثم الاسم</option>
                </select>
              </label>
            </div>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>الطالب</th>
                    <th>اسم المستخدم</th>
                    <th>الفرع</th>
                    <th>الصلاحية</th>
                    <th>تاريخ التسجيل</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filteredStudents.map((student) => (
                    <tr key={student.uid}>
                      <td>
                        <span className="admin-person">
                          <span className="user-chip__avatar">{student.displayName.slice(0, 1)}</span>
                          <strong>{student.displayName}</strong>
                        </span>
                      </td>
                      <td dir="ltr">@{student.username}</td>
                      <td>{branchName(student.branch)}</td>
                      <td>
                        <span className={roleBadge(student.role)}>
                          {student.role === "admin" ? "مشرف" : "طالب"}
                        </span>
                      </td>
                      <td>{formatDateTime(student.createdAt)}</td>
                      <td>
                        <div className="button-row admin-student-actions">
                          <button
                            className="button button--ghost button--sm"
                            type="button"
                            onClick={() => void showStudentDetails(student)}
                          >
                            تفاصيل
                          </button>
                          <button
                            className="button button--ghost button--sm"
                            type="button"
                            onClick={() => void copyUsername(student)}
                          >
                            نسخ الاسم
                          </button>
                          <button
                            className="button button--ghost button--sm"
                            type="button"
                            disabled={saving || student.uid === profile.uid}
                            onClick={() => void toggleRole(student)}
                          >
                            {student.role === "admin" ? "سحب الإشراف" : "تعيين مشرفًا"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredStudents.length === 0 ? (
              <p className="muted">لا توجد نتائج مطابقة.</p>
            ) : null}

            {studentDetail ? (
              <div className="admin-student-detail">
                <div className="admin-student-detail__head">
                  <div>
                    <span className="eyebrow"><UserIcon /> ملف الطالب</span>
                    <h3>{studentDetail.displayName}</h3>
                    <p className="muted small">
                      @{studentDetail.username} • {branchName(studentDetail.branch)} •{" "}
                      {studentDetail.role === "admin" ? "مشرف" : "طالب"}
                    </p>
                  </div>
                  <button
                    className="button button--ghost button--sm"
                    type="button"
                    onClick={() => setStudentDetail(null)}
                  >
                    <XIcon />
                    إغلاق
                  </button>
                </div>
                {studentDetailLoading ? (
                  <p className="muted small">نقرأ تقدم الطالب...</p>
                ) : studentDetailRows.length === 0 ? (
                  <p className="muted small">لم ينضم هذا الطالب إلى أي مادة بعد.</p>
                ) : (
                  <div className="admin-student-subjects">
                    {studentDetailRows.map((row) => {
                      const percent =
                        row.totalQuestions > 0
                          ? Math.min(100, Math.round((row.masteryCount / row.totalQuestions) * 100))
                          : 0;
                      return (
                        <div className="admin-student-subject" key={row.subjectId}>
                          <div className="admin-student-subject__top">
                            <strong>{row.subjectName}</strong>
                            <span className="muted small">
                              {formatNumber(row.masteryCount)} / {formatNumber(row.totalQuestions)}{" "}
                              إتقان
                            </span>
                          </div>
                          <div className="admin-progress-track" aria-hidden="true">
                            <span style={{ width: `${percent}%` }} />
                          </div>
                          <small className="muted">
                            {formatNumber(row.coverageCount)} مشاهدة •{" "}
                            {formatNumber(row.stagesCompleted)} مرحلة • {percent}% إتقان
                            {row.completedAt ? ` • اكتمل ${formatDateTime(row.completedAt)}` : ""}
                          </small>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {effectiveTab === "account" ? (
        <div className="admin-panel">
          <section className="admin-card admin-account-card">
            <div className="admin-card__heading">
              <div>
                <span className="eyebrow"><ShieldIcon /> أمان الحساب</span>
                <h2>تغيير اسم المستخدم وكلمة المرور</h2>
                <p className="muted small">
                  يُطلب إدخال كلمة المرور الحالية مرة واحدة لتأكيد العملية. لا تشارك بيانات
                  الدخول مع أي طالب.
                </p>
              </div>
            </div>

            <form className="form" onSubmit={saveCredentials}>
              <div className="admin-field-grid">
                <label className="field">
                  <span>اسم المستخدم الحالي</span>
                  <input className="input" value={profile.username} disabled dir="ltr" />
                </label>
                <label className="field">
                  <span>اسم المستخدم الجديد</span>
                  <input
                    className="input"
                    value={newUsername}
                    onChange={(event) => setNewUsername(event.target.value)}
                    dir="ltr"
                    minLength={3}
                    maxLength={20}
                    pattern="[A-Za-z0-9_]{3,20}"
                    required
                  />
                  <small>بعد الحفظ ستدخل بالاسم الجديد بدل admin.</small>
                </label>
              </div>
              <label className="field">
                <span>كلمة المرور الحالية</span>
                <input
                  className="input"
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              <div className="admin-field-grid">
                <label className="field">
                  <span>كلمة المرور الجديدة (اختياري)</span>
                  <input
                    className="input"
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    autoComplete="new-password"
                    minLength={6}
                  />
                </label>
                <label className="field">
                  <span>تأكيد كلمة المرور الجديدة</span>
                  <input
                    className="input"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <div className="alert alert--warning">
                كلمة المرور الافتراضية للحساب الأول هي <strong>admin123</strong> (Firebase
                يفرض 6 أحرف على الأقل). غيّرها الآن إلى كلمة قوية خاصة بك.
              </div>
              <button
                className="button button--primary button--lg"
                type="submit"
                disabled={saving}
              >
                <ShieldIcon />
                حفظ بيانات الدخول
              </button>
            </form>
          </section>
        </div>
      ) : null}

      {selectedSubject ? (
        <p className="admin-footnote muted small">
          الإعدادات تُطبّق عند بدء المرحلة التالية. الطالب داخل مرحلة مفتوحة يكملها كما هي،
          ثم تُطبّق القيم الجديدة.
        </p>
      ) : null}
    </div>
  );
}
