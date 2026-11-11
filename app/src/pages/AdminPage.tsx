import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
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
} from "firebase/firestore";
import {
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
  ANNOUNCEMENT_FONTS,
  announcementClasses,
  fetchAllAnnouncements,
  logAdminAction,
  removeAnnouncement,
  saveAnnouncement,
} from "../lib/announcements";
import { errorMessage } from "../lib/errors";
import { auth, db } from "../lib/firebase";
import { formatDateTime, formatNumber, toMillis } from "../lib/format";
import {
  applyBackgroundColor,
  BACKGROUND_PRESETS,
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_SUBJECT_SETTINGS,
  fetchGlobalSettings,
  fetchSubjectSettings,
  normalizeSubjectSettings,
  saveGlobalSettings,
  saveSubjectSettings,
} from "../lib/settings";
import type {
  AdminAuditEntry,
  AdminUserRow,
  Announcement,
  AnnouncementAnimation,
  AnnouncementFont,
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
  active: boolean;
  pinned: boolean;
  expiresAt: string;
}

const EMPTY_ANNOUNCEMENT: AnnouncementDraft = {
  title: "",
  body: "",
  tone: "info",
  animation: "slide-right",
  font: "default",
  active: true,
  pinned: false,
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

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

function dateInputValue(value: unknown): string {
  const millis = toMillis(value);
  if (!millis) return "";
  return new Date(millis).toISOString().slice(0, 10);
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
  const [draft, setDraft] = useState<AnnouncementDraft>(EMPTY_ANNOUNCEMENT);
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
    if (!needle) return students;
    return students.filter(
      (student) =>
        student.username.toLowerCase().includes(needle) ||
        student.displayName.toLowerCase().includes(needle),
    );
  }, [students, studentSearch]);

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
      applyBackgroundColor(saved.backgroundColor);
      await logAdminAction(
        profile,
        "settings.global",
        `${saved.stagesLocked ? "إغلاق المراحل" : "فتح المراحل"} • خلفية ${saved.backgroundColor}`,
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

  function editAnnouncement(announcement: Announcement) {
    setDraft({
      id: announcement.id,
      title: announcement.title,
      body: announcement.body,
      tone: announcement.tone,
      animation: announcement.animation,
      font: announcement.font,
      active: announcement.active,
      pinned: announcement.pinned,
      expiresAt: dateInputValue(announcement.expiresAt),
    });
    setTab("announcements");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submitAnnouncement(event: FormEvent) {
    event.preventDefault();
    if (!profile) return;
    if (!draft.title.trim() || !draft.body.trim()) {
      setError("اكتب عنوان الإعلان ونصه أولًا.");
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
          active: draft.active,
          pinned: draft.pinned,
          expiresAt: draft.expiresAt
            ? new Date(`${draft.expiresAt}T23:59:59`).getTime()
            : null,
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
      showNotice("تم حفظ الإعلان ونشره للطلاب.");
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

              <div className="field">
                <span>لون خلفية المنصة</span>
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
                      onClick={() =>
                        setGlobalSettings((previous) => ({
                          ...previous,
                          backgroundColor: preset.value,
                        }))
                      }
                    />
                  ))}
                  <label className="theme-swatch theme-swatch--custom" title="لون مخصص">
                    <input
                      type="color"
                      value={globalSettings.backgroundColor}
                      onChange={(event) =>
                        setGlobalSettings((previous) => ({
                          ...previous,
                          backgroundColor: event.target.value,
                        }))
                      }
                    />
                    <span>+</span>
                  </label>
                </div>
                <div className="theme-preview" style={{ backgroundColor: globalSettings.backgroundColor }}>
                  <strong>معاينة الخلفية</strong>
                  <span>يُطبّق اللون فور الحفظ على كل صفحات الطلاب.</span>
                </div>
                <small>اختر لونًا فاتحًا ليبقى النص مقروءًا. يمكنك أيضًا اختيار لون مخصص.</small>
              </div>
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
                    <small>100% تعني إتقان كل أسئلة المادة للشهادة.</small>
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
                      <small>لن تُصدر الشهادة قبل اجتيازه.</small>
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
          <section className="admin-card">
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
                  <span>حركة الإعلان</span>
                  <select
                    className="input"
                    value={draft.animation}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        animation: event.target.value as AnnouncementAnimation,
                      }))
                    }
                  >
                    {ANNOUNCEMENT_ANIMATIONS.map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label} — {option.description}
                      </option>
                    ))}
                  </select>
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
              </div>

              <div className="announcement-preview">
                <span className="eyebrow"><SparklesIcon /> معاينة مباشرة</span>
                <article
                  className={announcementClasses({
                    tone: draft.tone,
                    animation: draft.animation,
                    font: draft.font,
                  })}
                >
                  <span className="notice__icon"><MegaphoneIcon /></span>
                  <div className="notice__content">
                    <strong>{draft.title || "عنوان الإعلان"}</strong>
                    <p>{draft.body || "سيظهر نص رسالتك هنا بالحركة والخط المختارين."}</p>
                  </div>
                </article>
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
                <h2>{formatNumber(announcements.length)} رسالة</h2>
              </div>
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
            {announcements.length === 0 ? (
              <p className="muted">لا توجد إعلانات بعد.</p>
            ) : (
              <div className="admin-announcement-list">
                {announcements.map((announcement) => (
                  <article className="admin-announcement" key={announcement.id}>
                    <div className="admin-announcement__top">
                      <span className={`badge ${announcement.active ? "badge--green" : "badge--soft"}`}>
                        {announcement.active ? "منشور" : "مسودة"}
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
                      <span className="muted small">{formatDateTime(announcement.createdAt)}</span>
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
              <input
                className="input admin-search"
                value={studentSearch}
                onChange={(event) => setStudentSearch(event.target.value)}
                placeholder="ابحث باسم المستخدم أو الاسم الظاهر..."
              />
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
                        <button
                          className="button button--ghost button--sm"
                          type="button"
                          disabled={saving || student.uid === profile.uid}
                          onClick={() => void toggleRole(student)}
                        >
                          {student.role === "admin" ? "سحب الإشراف" : "تعيين مشرفًا"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredStudents.length === 0 ? (
              <p className="muted">لا توجد نتائج مطابقة.</p>
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
