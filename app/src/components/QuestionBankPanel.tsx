import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  collection,
  doc,
  getCountFromServer,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
  type QueryConstraint,
} from "firebase/firestore";
import {
  BookIcon,
  CheckIcon,
  RefreshIcon,
  SparklesIcon,
  TrashIcon,
  XIcon,
} from "./Icons";
import { logAdminAction } from "../lib/announcements";
import { errorMessage } from "../lib/errors";
import { db } from "../lib/firebase";
import { formatNumber, questionTypeLabel } from "../lib/format";
import {
  buildBankTemplate,
  fetchQuestionsForScope,
  importQuestionBank,
  parseBankText,
  parseQuickQuestions,
  QUESTION_TYPE_OPTIONS,
  removeQuestion,
  setQuestionActive,
  type BankLessonMeta,
  type BankQuestion,
  type BankUnitMeta,
  type ParsedBank,
} from "../lib/questionBank";
import type {
  Grading,
  Profile,
  QuestionType,
  Subject,
} from "../lib/types";

interface QuestionBankPanelProps {
  subjects: Subject[];
  profile: Profile;
  onChanged: () => void;
}

interface EditorState {
  type: QuestionType;
  text: string;
  optionsText: string;
  correctIndex: number;
  trueFalse: boolean;
  answer: string;
  explanation: string;
  points: number;
  active: boolean;
}

const AUTO_TYPES = new Set<QuestionType>(["mcq", "true_false", "fill_blank", "matching", "ordering"]);

const EMPTY_EDITOR: EditorState = {
  type: "mcq",
  text: "",
  optionsText: "",
  correctIndex: 0,
  trueFalse: true,
  answer: "",
  explanation: "",
  points: 1,
  active: true,
};

const QUICK_SAMPLE = `سؤال: ما الوحدة الوظيفية الأساسية للجهاز العصبي؟
نوع: mcq
خيارات: عصبون | خلية دبقية | نسيج عصبي | مشبك
الإجابة: 1
شرح: العصبون هو الوحدة الوظيفية للجهاز العصبي.
---
سؤال: اشرح بإيجاز أهمية المراجعة المتباعدة.
نوع: مقال
الإجابة: تعيد المراجعة المتباعدة المعلومات إلى الذاكرة على فترات متزايدة، ما يثبّت التعلم ويقلل النسيان.
نقاط: 2`;

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function scopeConstraints(
  subjectId: string,
  unitId: string,
  lessonId: string,
): QueryConstraint[] {
  const constraints: QueryConstraint[] = [where("subjectId", "==", subjectId)];
  if (unitId) constraints.push(where("unitId", "==", unitId));
  if (lessonId) constraints.push(where("lessonId", "==", lessonId));
  return constraints;
}

function asQuestion(id: string, data: Record<string, unknown>): BankQuestion {
  const type = (QUESTION_TYPE_OPTIONS.some((item) => item.value === data.type)
    ? data.type
    : "mcq") as QuestionType;
  const grading = (["auto", "self", "manual"].includes(String(data.grading))
    ? data.grading
    : AUTO_TYPES.has(type)
      ? "auto"
      : "self") as Grading;
  return {
    id,
    subjectId: String(data.subjectId ?? ""),
    unitId: String(data.unitId ?? ""),
    lessonId: String(data.lessonId ?? ""),
    type,
    text: String(data.text ?? ""),
    options: data.options ?? null,
    grading,
    correct: data.correct ?? null,
    modelAnswer: data.modelAnswer ?? null,
    explanation: typeof data.explanation === "string" ? data.explanation : null,
    points: Number(data.points ?? 1) || 1,
    orderIndex: Number.isFinite(Number(data.orderIndex)) ? Number(data.orderIndex) : undefined,
    active: data.active !== false,
  };
}

export function QuestionBankPanel({
  subjects,
  profile,
  onChanged,
}: QuestionBankPanelProps) {
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? "");
  const [units, setUnits] = useState<BankUnitMeta[]>([]);
  const [lessons, setLessons] = useState<BankLessonMeta[]>([]);
  const [unitId, setUnitId] = useState("");
  const [lessonId, setLessonId] = useState("");
  const [rows, setRows] = useState<BankQuestion[]>([]);
  const [scopeCount, setScopeCount] = useState(0);
  const [loadingScope, setLoadingScope] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [quickText, setQuickText] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [newUnitTitle, setNewUnitTitle] = useState("");
  const [newLessonTitle, setNewLessonTitle] = useState("");
  const [pending, setPending] = useState<{
    kind: "json" | "quick";
    parsed: ParsedBank;
  } | null>(null);

  const selectedSubject = useMemo(
    () => subjects.find((subject) => subject.id === subjectId) ?? null,
    [subjectId, subjects],
  );
  const filteredLessons = useMemo(
    () => (unitId ? lessons.filter((lesson) => lesson.unitId === unitId) : lessons),
    [lessons, unitId],
  );
  const editorMeta = QUESTION_TYPE_OPTIONS.find((item) => item.value === editor.type) ?? QUESTION_TYPE_OPTIONS[0];
  const optionRows = editor.optionsText
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const correctIndex = Math.min(editor.correctIndex, Math.max(0, optionRows.length - 1));

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 5000);
  }, []);

  const loadTaxonomy = useCallback(async (nextSubjectId: string) => {
    if (!db || !nextSubjectId) {
      setUnits([]);
      setLessons([]);
      return;
    }
    try {
      const [unitSnap, lessonSnap] = await Promise.all([
        getDocs(query(collection(db, "units"), where("subjectId", "==", nextSubjectId))),
        getDocs(query(collection(db, "lessons"), where("subjectId", "==", nextSubjectId))),
      ]);
      const nextUnits = unitSnap.docs
        .map((item) => {
          const data = item.data();
          return {
            id: item.id,
            subjectId: String(data.subjectId ?? nextSubjectId),
            title: String(data.title ?? ""),
            sort: Number(data.sort ?? 0),
          };
        })
        .sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title));
      const nextLessons = lessonSnap.docs
        .map((item) => {
          const data = item.data();
          return {
            id: item.id,
            subjectId: String(data.subjectId ?? nextSubjectId),
            unitId: String(data.unitId ?? ""),
            title: String(data.title ?? ""),
            sort: Number(data.sort ?? 0),
          };
        })
        .sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title));
      setUnits(nextUnits);
      setLessons(nextLessons);
      setUnitId((current) =>
        current && nextUnits.some((unit) => unit.id === current) ? current : "",
      );
      setLessonId((current) =>
        current && nextLessons.some((lesson) => lesson.id === current) ? current : "",
      );
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  const loadScope = useCallback(async () => {
    if (!db || !subjectId) {
      setRows([]);
      setScopeCount(0);
      return;
    }
    setLoadingScope(true);
    setError("");
    try {
      const constraints = scopeConstraints(subjectId, unitId, lessonId);
      const [countSnap, listSnap] = await Promise.all([
        getCountFromServer(query(collection(db, "questions"), ...constraints)),
        getDocs(query(collection(db, "questions"), ...constraints, limit(120))),
      ]);
      setScopeCount(countSnap.data().count);
      setRows(
        listSnap.docs
          .map((item) => asQuestion(item.id, item.data()))
          .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0)),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoadingScope(false);
    }
  }, [lessonId, subjectId, unitId]);

  useEffect(() => {
    if (!subjectId && subjects.length > 0) setSubjectId(subjects[0].id);
  }, [subjectId, subjects]);

  useEffect(() => {
    void loadTaxonomy(subjectId);
  }, [loadTaxonomy, subjectId]);

  useEffect(() => {
    void loadScope();
  }, [loadScope]);

  useEffect(() => {
    if (!lessonId) return;
    const lesson = lessons.find((item) => item.id === lessonId);
    if (lesson && lesson.unitId && lesson.unitId !== unitId) {
      setUnitId(lesson.unitId);
    }
  }, [lessonId, lessons, unitId]);

  function refreshAll() {
    void loadScope();
    void loadTaxonomy(subjectId);
    onChanged();
  }

  async function createUnit(event: FormEvent) {
    event.preventDefault();
    if (!db || !subjectId || !newUnitTitle.trim()) {
      setError("اختر المادة واكتب عنوان الوحدة.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const ref = doc(collection(db, "units"));
      const sort = Math.max(0, ...units.map((unit) => unit.sort ?? 0)) + 1;
      await setDoc(ref, {
        subjectId,
        title: newUnitTitle.trim(),
        sort,
        totalQuestions: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await logAdminAction(profile, "units.create", newUnitTitle.trim());
      setNewUnitTitle("");
      await loadTaxonomy(subjectId);
      setUnitId(ref.id);
      setLessonId("");
      showNotice("أُضيفت الوحدة. أضف درسًا أو استورد أسئلتها.");
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function createLesson(event: FormEvent) {
    event.preventDefault();
    if (!db || !subjectId || !unitId || !newLessonTitle.trim()) {
      setError("اختر المادة والوحدة واكتب عنوان الدرس.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const ref = doc(collection(db, "lessons"));
      const sort =
        Math.max(
          0,
          ...lessons
            .filter((lesson) => lesson.unitId === unitId)
            .map((lesson) => lesson.sort ?? 0),
        ) + 1;
      await setDoc(ref, {
        subjectId,
        unitId,
        title: newLessonTitle.trim(),
        sort,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await logAdminAction(
        profile,
        "lessons.create",
        `${units.find((unit) => unit.id === unitId)?.title ?? unitId} / ${newLessonTitle.trim()}`,
      );
      setNewLessonTitle("");
      await loadTaxonomy(subjectId);
      setUnitId(unitId);
      setLessonId(ref.id);
      showNotice("أُضيف الدرس ويمكنك إضافة السؤال الآن.");
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  function changeType(type: QuestionType) {
    const meta = QUESTION_TYPE_OPTIONS.find((item) => item.value === type);
    setEditor((previous) => ({
      ...previous,
      type,
      points: meta?.grading === "auto" ? 1 : 2,
      answer: "",
      correctIndex: 0,
      trueFalse: true,
    }));
  }

  function buildQuestion(): Record<string, unknown> | null {
    if (!subjectId || !unitId || !lessonId) {
      setError("اختر المادة والوحدة والدرس أولًا.");
      return null;
    }
    if (!editor.text.trim()) {
      setError("اكتب نص السؤال.");
      return null;
    }
    const base: Record<string, unknown> = {
      subjectId,
      unitId,
      lessonId,
      type: editor.type,
      text: editor.text,
      explanation: editor.explanation,
      points: editor.points,
      active: editor.active,
    };
    if (editor.type === "mcq") {
      if (optionRows.length < 2) {
        setError("أضف خيارين على الأقل، كل خيار في سطر.");
        return null;
      }
      base.options = optionRows;
      base.correct = { index: correctIndex };
      base.modelAnswer = optionRows[correctIndex];
    } else if (editor.type === "true_false") {
      base.correct = { value: editor.trueFalse };
      base.modelAnswer = editor.trueFalse ? "صح" : "خطأ";
    } else if (editor.type === "fill_blank") {
      if (!editor.answer.trim()) {
        setError("اكتب إجابة الفراغ.");
        return null;
      }
      base.correct = { text: editor.answer.trim() };
      base.modelAnswer = editor.answer.trim();
    } else {
      if (!editor.answer.trim()) {
        setError("اكتب الإجابة النموذجية.");
        return null;
      }
      base.modelAnswer = editor.answer.trim();
    }
    return base;
  }

  async function addSingleQuestion(event: FormEvent) {
    event.preventDefault();
    const raw = buildQuestion();
    if (!raw) return;
    setSaving(true);
    setError("");
    try {
      const parsed = parseBankText(JSON.stringify({ questions: [raw] }), {
        subjectId,
        unitId,
        lessonId,
      });
      const result = await importQuestionBank(parsed, profile, (done, total) =>
        setProgress({ done, total }),
      );
      await logAdminAction(
        profile,
        "questions.create",
        `${selectedSubject?.name ?? subjectId}: ${editor.text.slice(0, 70)}`,
      );
      setEditor((previous) => ({
        ...EMPTY_EDITOR,
        type: previous.type,
        points: previous.points,
      }));
      showNotice(
        result.enrollmentsUpdated > 0
          ? `أُضيف السؤال، وحُدّث تقدم ${formatNumber(result.enrollmentsUpdated)} طالبًا.`
          : "أُضيف السؤال إلى بنك المادة.",
      );
      refreshAll();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
      setProgress(null);
    }
  }

  async function previewQuick() {
    setError("");
    if (!subjectId || !unitId || !lessonId) {
      setError("اختر المادة والوحدة والدرس قبل استيراد الدفعة.");
      return;
    }
    try {
      const parsed = parseQuickQuestions(quickText, { subjectId, unitId, lessonId });
      setPending({ kind: "quick", parsed });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function previewJson() {
    setError("");
    if (!jsonText.trim()) {
      setError("اختر ملف JSON أو الصق محتواه أولًا.");
      return;
    }
    try {
      const parsed = parseBankText(jsonText, { subjectId, unitId, lessonId });
      setPending({ kind: "json", parsed });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function confirmImport() {
    if (!pending) return;
    setSaving(true);
    setError("");
    try {
      const result = await importQuestionBank(pending.parsed, profile, (done, total) =>
        setProgress({ done, total }),
      );
      await logAdminAction(
        profile,
        "questions.import",
        `${selectedSubject?.name ?? subjectId}: ${result.questions} سؤال، ${result.units} وحدة، ${result.lessons} درس`,
      );
      showNotice(
        `تم استيراد ${formatNumber(result.questions)} سؤالًا` +
          (result.enrollmentsUpdated > 0
            ? ` وتحديث تقدم ${formatNumber(result.enrollmentsUpdated)} طالبًا.`
            : "."),
      );
      setPending(null);
      setQuickText("");
      setJsonText("");
      refreshAll();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
      setProgress(null);
    }
  }

  async function toggleActive(row: BankQuestion) {
    setSaving(true);
    setError("");
    try {
      await setQuestionActive(row, !row.active, profile);
      await logAdminAction(
        profile,
        "questions.toggle",
        `${row.text.slice(0, 60)} → ${row.active ? "تعطيل" : "تفعيل"}`,
      );
      showNotice(row.active ? "تم تعطيل السؤال." : "تم تفعيل السؤال.");
      refreshAll();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function deleteRow(row: BankQuestion) {
    if (!window.confirm(`حذف السؤال «${row.text.slice(0, 80)}» نهائيًا؟`)) return;
    setSaving(true);
    setError("");
    try {
      await removeQuestion(row, profile);
      await logAdminAction(profile, "questions.delete", row.text.slice(0, 80));
      showNotice("تم حذف السؤال وتحديث الإجماليات.");
      refreshAll();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function exportScope() {
    if (!selectedSubject) return;
    setSaving(true);
    setError("");
    try {
      const questions = await fetchQuestionsForScope(subjectId, unitId, lessonId);
      const scopedUnits = unitId ? units.filter((unit) => unit.id === unitId) : units;
      const scopedLessons = lessonId
        ? lessons.filter((lesson) => lesson.id === lessonId)
        : unitId
          ? lessons.filter((lesson) => lesson.unitId === unitId)
          : lessons;
      const file = {
        format: "bakaloriastages-bank",
        version: 1,
        exportedAt: new Date().toISOString(),
        subjects: [
          {
            id: selectedSubject.id,
            name: selectedSubject.name,
            branches: selectedSubject.branches,
            active: selectedSubject.active,
            sort: selectedSubject.sort ?? 1,
          },
        ],
        units: scopedUnits.map((unit) => ({
          id: unit.id,
          subjectId: unit.subjectId,
          title: unit.title,
          sort: unit.sort,
        })),
        lessons: scopedLessons.map((lesson) => ({
          id: lesson.id,
          subjectId: lesson.subjectId,
          unitId: lesson.unitId,
          title: lesson.title,
          sort: lesson.sort,
        })),
        questions: questions.map((question) => ({
          ...question,
          subjectId: String(question.subjectId ?? subjectId),
          unitId: String(question.unitId ?? unitId),
          lessonId: String(question.lessonId ?? lessonId),
        })),
        notes: ["نسخة احتياطية قابلة لإعادة الاستيراد من تبويب بنك الأسئلة."],
      };
      const suffix = lessonId || unitId || "all";
      downloadJson(`bank-${selectedSubject.id}-${suffix}.json`, file);
      showNotice(`تم تصدير ${formatNumber(questions.length)} سؤالًا.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  function downloadTemplate() {
    if (!selectedSubject) return;
    const template = buildBankTemplate({
      subject: selectedSubject,
      units,
      lessons,
      unitId,
      lessonId,
    });
    const suffix = lessonId || unitId || "all";
    downloadJson(`template-${selectedSubject.id}-${suffix}.json`, template);
    showNotice("تم تنزيل القالب. أضف الأسئلة داخل questions ثم استورده.");
  }

  async function handleFile(file: File | null) {
    if (!file) return;
    try {
      setJsonText(await file.text());
      setError("");
    } catch {
      setError("تعذر قراءة الملف.");
    }
  }

  function setContext(nextSubjectId: string, nextUnitId: string, nextLessonId: string) {
    setSubjectId(nextSubjectId);
    setUnitId(nextUnitId);
    setLessonId(nextLessonId);
    setPending(null);
  }

  if (subjects.length === 0) {
    return (
      <div className="admin-panel">
        <section className="admin-card">
          <p className="muted">لا توجد مواد بعد. أضف مادة أولًا من إعدادات المواد أو استورد بنكًا.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="admin-panel question-bank-page">
      <section className="admin-card">
        <div className="admin-card__heading">
          <div>
            <span className="eyebrow"><BookIcon /> بنك الأسئلة</span>
            <h2>أضف أسئلة جديدة أو وسّع درسًا كاملًا</h2>
            <p className="muted small">
              اختر المادة والوحدة والدرس، ثم أضف سؤالًا واحدًا أو استورد دفعة جاهزة. يتم
              تحديث إجماليات المادة وتقدم الطلاب غير المكتملين تلقائيًا.
            </p>
          </div>
          <button
            className="button button--ghost button--sm"
            type="button"
            onClick={() => void loadScope()}
            disabled={loadingScope || saving}
          >
            <RefreshIcon />
            تحديث
          </button>
        </div>

        <div className="admin-field-grid admin-bank-filters">
          <label className="field">
            <span>المادة</span>
            <select
              className="input"
              value={subjectId}
              onChange={(event) => setContext(event.target.value, "", "")}
            >
              {subjects.map((subject) => (
                <option value={subject.id} key={subject.id}>
                  {subject.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>الوحدة</span>
            <select
              className="input"
              value={unitId}
              onChange={(event) => setContext(subjectId, event.target.value, "")}
            >
              <option value="">كل الوحدات</option>
              {units.map((unit) => (
                <option value={unit.id} key={unit.id}>
                  {unit.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>الدرس</span>
            <select
              className="input"
              value={lessonId}
              onChange={(event) => {
                const nextLessonId = event.target.value;
                const lesson = lessons.find((item) => item.id === nextLessonId);
                setContext(subjectId, lesson?.unitId || unitId, nextLessonId);
              }}
            >
              <option value="">كل الدروس</option>
              {filteredLessons.map((lesson) => (
                <option value={lesson.id} key={lesson.id}>
                  {lesson.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="admin-bank-summary">
          <span className="badge badge--green">{formatNumber(scopeCount)} سؤال في النطاق</span>
          <span className="badge badge--soft">{formatNumber(units.length)} وحدة</span>
          <span className="badge badge--soft">{formatNumber(lessons.length)} درس</span>
          {!unitId || !lessonId ? (
            <span className="muted small">اختر وحدة ودرسًا لإضافة سؤال فردي أو استيراد دفعة.</span>
          ) : (
            <span className="muted small">
              النطاق الحالي: {units.find((unit) => unit.id === unitId)?.title} /{" "}
              {lessons.find((lesson) => lesson.id === lessonId)?.title}
            </span>
          )}
        </div>

        <details className="admin-details admin-taxonomy-create">
          <summary>إضافة وحدة أو درس جديد</summary>
          <div className="admin-taxonomy-grid">
            <form className="admin-inline-form" onSubmit={createUnit}>
              <label className="field">
                <span>وحدة جديدة داخل المادة</span>
                <input
                  className="input"
                  value={newUnitTitle}
                  onChange={(event) => setNewUnitTitle(event.target.value)}
                  placeholder="مثال: الوحدة الرابعة — التكاثر"
                  disabled={saving}
                />
              </label>
              <button className="button button--ghost button--sm" type="submit" disabled={saving}>
                <CheckIcon />
                إضافة الوحدة
              </button>
            </form>
            <form className="admin-inline-form" onSubmit={createLesson}>
              <label className="field">
                <span>درس جديد داخل الوحدة المختارة</span>
                <input
                  className="input"
                  value={newLessonTitle}
                  onChange={(event) => setNewLessonTitle(event.target.value)}
                  placeholder="مثال: الدرس الثالث — الهرمونات"
                  disabled={saving || !unitId}
                />
                {!unitId ? <small>اختر وحدة أولًا من القائمة أعلاه.</small> : null}
              </label>
              <button
                className="button button--ghost button--sm"
                type="submit"
                disabled={saving || !unitId}
              >
                <CheckIcon />
                إضافة الدرس
              </button>
            </form>
          </div>
        </details>

        {error ? <div className="alert alert--error">{error}</div> : null}
        {notice ? <div className="alert alert--success">{notice}</div> : null}
        {progress ? (
          <div className="alert alert--info">
            جارٍ الحفظ... {formatNumber(progress.done)} / {formatNumber(progress.total)} سؤال
          </div>
        ) : null}
      </section>

      <div className="admin-split admin-bank-editor">
        <section className="admin-card">
          <div className="admin-card__heading">
            <div>
              <span className="eyebrow"><SparklesIcon /> إضافة سؤال واحد</span>
              <h2>محرر السؤال</h2>
            </div>
          </div>

          <form className="form" onSubmit={addSingleQuestion}>
            <div className="admin-field-grid">
              <label className="field">
                <span>نوع السؤال</span>
                <select
                  className="input"
                  value={editor.type}
                  onChange={(event) => changeType(event.target.value as QuestionType)}
                >
                  {QUESTION_TYPE_OPTIONS.map((option) => (
                    <option value={option.value} key={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <small>{editorMeta.hint}</small>
              </label>
              <label className="field">
                <span>الدرجة</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  value={editor.points}
                  onChange={(event) =>
                    setEditor((previous) => ({
                      ...previous,
                      points: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="admin-switch admin-switch--compact admin-switch--editor">
                <input
                  type="checkbox"
                  checked={editor.active}
                  onChange={(event) =>
                    setEditor((previous) => ({ ...previous, active: event.target.checked }))
                  }
                />
                <span className="admin-switch__track" />
                <span><strong>سؤال نشط</strong></span>
              </label>
            </div>

            <label className="field">
              <span>نص السؤال</span>
              <textarea
                className="textarea"
                rows={3}
                value={editor.text}
                onChange={(event) =>
                  setEditor((previous) => ({ ...previous, text: event.target.value }))
                }
                placeholder="اكتب نص السؤال كما سيظهر للطالب..."
                required
              />
            </label>

            {editor.type === "mcq" ? (
              <>
                <label className="field">
                  <span>الخيارات — كل خيار في سطر</span>
                  <textarea
                    className="textarea"
                    rows={4}
                    value={editor.optionsText}
                    onChange={(event) =>
                      setEditor((previous) => ({
                        ...previous,
                        optionsText: event.target.value,
                      }))
                    }
                    placeholder={"الخيار الأول\nالخيار الثاني\nالخيار الثالث\nالخيار الرابع"}
                  />
                  <small>{formatNumber(optionRows.length)} خيارات. الحد الأدنى 2.</small>
                </label>
                <label className="field">
                  <span>الخيار الصحيح</span>
                  <select
                    className="input"
                    value={correctIndex}
                    onChange={(event) =>
                      setEditor((previous) => ({
                        ...previous,
                        correctIndex: Number(event.target.value),
                      }))
                    }
                  >
                    {optionRows.length === 0 ? <option value={0}>أضف الخيارات أولًا</option> : null}
                    {optionRows.map((option, index) => (
                      <option value={index} key={`${option}-${index}`}>
                        {index + 1}. {option}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}

            {editor.type === "true_false" ? (
              <label className="field">
                <span>الإجابة الصحيحة</span>
                <select
                  className="input"
                  value={editor.trueFalse ? "true" : "false"}
                  onChange={(event) =>
                    setEditor((previous) => ({
                      ...previous,
                      trueFalse: event.target.value === "true",
                    }))
                  }
                >
                  <option value="true">صح</option>
                  <option value="false">خطأ</option>
                </select>
              </label>
            ) : null}

            {editor.type === "fill_blank" || !["mcq", "true_false"].includes(editor.type) ? (
              <label className="field">
                <span>
                  {editor.type === "fill_blank" ? "إجابة الفراغ الصحيحة" : "الإجابة النموذجية"}
                </span>
                <textarea
                  className="textarea"
                  rows={editor.type === "fill_blank" ? 2 : 4}
                  value={editor.answer}
                  onChange={(event) =>
                    setEditor((previous) => ({ ...previous, answer: event.target.value }))
                  }
                  placeholder={
                    editor.type === "fill_blank"
                      ? "الكلمة أو العبارة الصحيحة"
                      : "النقاط التي سيقارن بها الطالب إجابته..."
                  }
                  required
                />
              </label>
            ) : null}

            <label className="field">
              <span>شرح اختياري</span>
              <textarea
                className="textarea"
                rows={2}
                value={editor.explanation}
                onChange={(event) =>
                  setEditor((previous) => ({ ...previous, explanation: event.target.value }))
                }
                placeholder="يظهر بعد تسليم المرحلة لمساعدة الطالب على الفهم."
              />
            </label>

            <button
              className="button button--primary button--lg"
              type="submit"
              disabled={saving || !unitId || !lessonId}
            >
              <CheckIcon />
              حفظ السؤال في البنك
            </button>
          </form>
        </section>

        <section className="admin-card">
          <div className="admin-card__heading">
            <div>
              <span className="eyebrow"><BookIcon /> استيراد وتصدير</span>
              <h2>دفعة أسئلة أو ملف JSON</h2>
            </div>
          </div>

          <div className="admin-bank-tools">
            <button className="button button--ghost" type="button" onClick={downloadTemplate}>
              <BookIcon />
              تنزيل قالب JSON
            </button>
            <button
              className="button button--ghost"
              type="button"
              onClick={() => void exportScope()}
              disabled={saving}
            >
              <SparklesIcon />
              تصدير أسئلة النطاق
            </button>
          </div>

          <p className="muted small">
            القالب يطابق بنية ملفات البنك الحالية. املأ مصفوفة <code>questions</code> ثم
            استورد الملف. يمكن حذف <code>examples</code> فهي للتوضيح فقط.
          </p>

          <details className="admin-details" open>
            <summary>استيراد سريع من مربع نص</summary>
            <label className="field">
              <span>صيغة سريعة — افصل بين الأسئلة بسطر <code>---</code></span>
              <textarea
                className="textarea textarea--code admin-bank-code"
                rows={10}
                value={quickText}
                onChange={(event) => setQuickText(event.target.value)}
                placeholder={QUICK_SAMPLE}
              />
              <small>
                المفاتيح: سؤال، نوع، خيارات (مفصولة بـ |)، الإجابة، شرح، نقاط. الإجابة في
                الاختيار من متعدد تبدأ من 1.
              </small>
            </label>
            <div className="button-row">
              <button
                className="button button--ghost button--sm"
                type="button"
                onClick={() => setQuickText(QUICK_SAMPLE)}
              >
                إدخال مثال
              </button>
              <button
                className="button button--primary button--sm"
                type="button"
                onClick={() => void previewQuick()}
                disabled={saving || !quickText.trim()}
              >
                معاينة الدفعة
              </button>
            </div>
          </details>

          <details className="admin-details">
            <summary>استيراد ملف JSON</summary>
            <label className="field">
              <span>اختر ملف JSON</span>
              <input
                className="input"
                type="file"
                accept=".json,application/json"
                onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <label className="field">
              <span>أو الصق محتوى JSON</span>
              <textarea
                className="textarea textarea--code admin-bank-code"
                rows={8}
                value={jsonText}
                onChange={(event) => setJsonText(event.target.value)}
                placeholder='{"questions": [...]}'
              />
            </label>
            <button
              className="button button--primary button--sm"
              type="button"
              onClick={() => void previewJson()}
              disabled={saving || !jsonText.trim()}
            >
              معاينة ملف JSON
            </button>
          </details>

          {pending ? (
            <div className="admin-import-preview">
              <span className="eyebrow"><CheckIcon /> جاهز للاستيراد</span>
              <h3>
                {formatNumber(pending.parsed.questions.length)} سؤال •{" "}
                {formatNumber(pending.parsed.units.length)} وحدة •{" "}
                {formatNumber(pending.parsed.lessons.length)} درس
              </h3>
              <p className="muted small">
                سيتم تحديث إجماليات المادة والوحدات، وسيُحدّث عدد أسئلة الطلاب الحاليين
                غير المكتملين. المصدر: {pending.kind === "json" ? "ملف JSON" : "الصيغة السريعة"}.
              </p>
              {pending.parsed.warnings.length > 0 ? (
                <ul className="admin-warning-list">
                  {pending.parsed.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              <div className="button-row">
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => void confirmImport()}
                  disabled={saving}
                >
                  <CheckIcon />
                  تأكيد الاستيراد
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => setPending(null)}
                  disabled={saving}
                >
                  <XIcon />
                  إلغاء
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <section className="admin-card">
        <div className="admin-card__heading">
          <div>
            <span className="eyebrow"><BookIcon /> الأسئلة الحالية</span>
            <h2>
              {formatNumber(scopeCount)} سؤال — عرض {formatNumber(rows.length)}
            </h2>
          </div>
          <span className="badge badge--soft">مرتبة حسب orderIndex</span>
        </div>

        {loadingScope ? (
          <p className="muted">نقرأ الأسئلة...</p>
        ) : rows.length === 0 ? (
          <p className="muted">لا توجد أسئلة في النطاق المحدد بعد.</p>
        ) : (
          <div className="admin-question-list">
            {rows.map((row) => (
              <article className="admin-question-row" key={row.id}>
                <div className="admin-question-row__top">
                  <span className="badge badge--soft">#{formatNumber(row.orderIndex ?? 0)}</span>
                  <span className="badge badge--gold">{questionTypeLabel(row.type)}</span>
                  <span className={`badge ${row.active ? "badge--green" : "badge--red"}`}>
                    {row.active ? "نشط" : "معطّل"}
                  </span>
                  <span className="muted small">{row.grading === "auto" ? "تصحيح تلقائي" : "تقييم ذاتي"}</span>
                </div>
                <p>{row.text}</p>
                <div className="button-row">
                  <button
                    className="button button--ghost button--sm"
                    type="button"
                    onClick={() => void toggleActive(row)}
                    disabled={saving}
                  >
                    {row.active ? "تعطيل" : "تفعيل"}
                  </button>
                  <button
                    className="button button--danger-ghost button--sm"
                    type="button"
                    onClick={() => void deleteRow(row)}
                    disabled={saving}
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

      <p className="admin-footnote muted small">
        أي إضافة أو حذف قد يستهلك من حصة الكتابة اليومية في خطة Firebase المجانية.
        استورد دفعات كبيرة على فترات، وتجنّب إعادة استيراد البنك نفسه مرتين في اليوم.
      </p>
    </div>
  );
}
