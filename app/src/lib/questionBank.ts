import {
  collection,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type DocumentData,
  type QueryConstraint,
} from "firebase/firestore";
import { backendMode, db } from "./firebase";
import { fetchSubjectSettings } from "./settings";
import type {
  Branch,
  Grading,
  Profile,
  QuestionType,
  Subject,
} from "./types";

export const QUESTION_TYPE_OPTIONS: Array<{
  value: QuestionType;
  label: string;
  grading: Grading;
  hint: string;
}> = [
  { value: "mcq", label: "اختيار من متعدد", grading: "auto", hint: "خياران أو أكثر وإجابة صحيحة واحدة" },
  { value: "true_false", label: "صح أو خطأ", grading: "auto", hint: "حدد الإجابة الصحيحة" },
  { value: "fill_blank", label: "إكمال فراغ", grading: "auto", hint: "إجابة نصية قصيرة" },
  { value: "matching", label: "مطابقة", grading: "self", hint: "إجابة نموذجية وتقييم ذاتي" },
  { value: "ordering", label: "ترتيب", grading: "self", hint: "ترتيب عناصر أو مراحل" },
  { value: "comparison", label: "مقارنة", grading: "self", hint: "جدول أو نقاط مقارنة" },
  { value: "short_answer", label: "إجابة قصيرة", grading: "self", hint: "إجابة نموذجية وتقييم ذاتي" },
  { value: "essay", label: "مقال", grading: "self", hint: "إجابة مطوّلة وتقييم ذاتي" },
];

const TYPE_VALUES = new Set(QUESTION_TYPE_OPTIONS.map((item) => item.value));
const AUTO_TYPES = new Set<QuestionType>(["mcq", "true_false", "fill_blank", "matching", "ordering"]);
const GRADING_VALUES = new Set<Grading>(["auto", "self", "manual"]);

export interface BankSubjectMeta {
  id: string;
  name: string;
  branches?: Branch[];
  active?: boolean;
  sort?: number;
}

export interface BankUnitMeta {
  id: string;
  subjectId: string;
  title: string;
  sort?: number;
}

export interface BankLessonMeta {
  id: string;
  subjectId: string;
  unitId: string;
  title: string;
  sort?: number;
}

export interface BankQuestion {
  id: string;
  subjectId: string;
  unitId: string;
  lessonId: string;
  type: QuestionType;
  text: string;
  options: unknown;
  grading: Grading;
  correct: unknown;
  modelAnswer: unknown;
  explanation: string | null;
  points: number;
  orderIndex?: number;
  active: boolean;
}

export interface ParsedBank {
  subjects: BankSubjectMeta[];
  units: BankUnitMeta[];
  lessons: BankLessonMeta[];
  questions: BankQuestion[];
  warnings: string[];
}

export interface QuestionContext {
  subjectId?: string;
  unitId?: string;
  lessonId?: string;
}

export interface ImportSummary {
  questions: number;
  units: number;
  lessons: number;
  subjects: number;
  enrollmentsUpdated: number;
  warnings: string[];
}

function fail(message: string): never {
  throw new Error(message);
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label}: مطلوب نص غير فارغ.`);
  }
  return value.trim();
}

function asId(value: unknown, label: string): string {
  const id = asString(value, label);
  if (id.includes("/")) fail(`${label}: لا يمكن أن يحتوي المعرّف على "/".`);
  return id;
}

function asNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${label}: مطلوب رقم صحيح.`);
  return parsed;
}

function asOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return asNumber(value, label);
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label}: مطلوب مصفوفة.`);
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label}: مطلوب كائن JSON.`);
  }
  return value as Record<string, unknown>;
}

function textOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.trim()) {
      return record.text.trim();
    }
  }
  return null;
}

function parseBranchList(value: unknown, label: string): Branch[] | undefined {
  if (value === undefined) return undefined;
  const branches = asArray(value, label)
    .map((item) => String(item))
    .filter((item): item is Branch => item === "scientific" || item === "literary");
  if (branches.length === 0) fail(`${label}: اختر علمي أو أدبي على الأقل.`);
  return [...new Set(branches)];
}

function normalizeCorrect(
  type: QuestionType,
  correct: unknown,
  options: unknown[],
  path: string,
): unknown {
  if (correct === undefined || correct === null) {
    fail(`${path}.correct: مطلوب للإجابة المصححة تلقائيًا.`);
  }
  if (type === "mcq") {
    const rawIndex =
      correct && typeof correct === "object" && !Array.isArray(correct)
        ? (correct as Record<string, unknown>).index
        : correct;
    let index: number;
    if (typeof rawIndex === "number") {
      index = rawIndex;
    } else if (typeof rawIndex === "string" && rawIndex.trim() !== "") {
      const numeric = Number(rawIndex);
      index = Number.isFinite(numeric)
        ? numeric
        : options.findIndex((option) => String(option).trim() === rawIndex.trim());
    } else {
      fail(`${path}.correct.index: مطلوب رقم أو نص مطابق لأحد الخيارات.`);
    }
    if (!Number.isInteger(index) || index < 0 || index >= options.length) {
      fail(`${path}.correct.index: خارج نطاق الخيارات.`);
    }
    return { index };
  }
  if (type === "true_false") {
    const rawValue =
      correct && typeof correct === "object" && !Array.isArray(correct)
        ? (correct as Record<string, unknown>).value
        : correct;
    if (typeof rawValue === "boolean") return { value: rawValue };
    const normalized = String(rawValue ?? "").trim().toLowerCase();
    if (["true", "1", "صح", "صحيح", "نعم"].includes(normalized)) return { value: true };
    if (["false", "0", "خطأ", "خطا", "لا"].includes(normalized)) return { value: false };
    fail(`${path}.correct.value: استخدم true/false أو صح/خطأ.`);
  }
  if (type === "fill_blank") {
    const text =
      correct && typeof correct === "object" && !Array.isArray(correct)
        ? (correct as Record<string, unknown>).text
        : correct;
    return { text: asString(text, `${path}.correct.text`) };
  }
  return correct;
}

function defaultModelAnswer(
  type: QuestionType,
  correct: unknown,
  options: unknown[],
): unknown {
  if (type === "mcq") {
    const index = Number(
      correct && typeof correct === "object"
        ? (correct as Record<string, unknown>).index
        : correct,
    );
    return options[index] ?? correct;
  }
  if (type === "true_false") {
    const value =
      correct && typeof correct === "object"
        ? (correct as Record<string, unknown>).value
        : correct;
    return value ? "صح" : "خطأ";
  }
  if (type === "fill_blank") {
    return correct && typeof correct === "object"
      ? (correct as Record<string, unknown>).text
      : correct;
  }
  return correct;
}

function generatedQuestionId(subjectId: string): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return `${subjectId}-q-${uuid}`;
}

function normalizeQuestion(
  raw: Record<string, unknown>,
  fallback: QuestionContext,
  index: number,
): BankQuestion {
  const path = `questions[${index}]`;
  const subjectId = asId(raw.subjectId ?? fallback.subjectId, `${path}.subjectId`);
  const unitId = asId(raw.unitId ?? fallback.unitId, `${path}.unitId`);
  const lessonId = asId(raw.lessonId ?? fallback.lessonId, `${path}.lessonId`);
  const type = asString(raw.type, `${path}.type`) as QuestionType;
  if (!TYPE_VALUES.has(type)) fail(`${path}.type: نوع السؤال غير مدعوم.`);
  const text = asString(raw.text, `${path}.text`);
  const id =
    raw.id === undefined || raw.id === null || raw.id === ""
      ? generatedQuestionId(subjectId)
      : asId(raw.id, `${path}.id`);

  let options: unknown = null;
  if (type === "mcq") {
    const list = asArray(raw.options, `${path}.options`);
    if (list.length < 2) fail(`${path}.options: يحتاج السؤال إلى خيارين على الأقل.`);
    options = list;
  } else if (raw.options !== undefined && raw.options !== null) {
    options = raw.options;
  }

  const gradingRaw =
    raw.grading ??
    QUESTION_TYPE_OPTIONS.find((item) => item.value === type)?.grading ??
    (AUTO_TYPES.has(type) ? "auto" : "self");
  const grading = asString(gradingRaw, `${path}.grading`) as Grading;
  if (!GRADING_VALUES.has(grading)) {
    fail(`${path}.grading: استخدم auto أو self أو manual.`);
  }
  if (grading === "auto" && !AUTO_TYPES.has(type)) {
    fail(`${path}.grading: هذا النوع لا يدعم التصحيح التلقائي.`);
  }

  const correct =
    grading === "auto"
      ? normalizeCorrect(type, raw.correct, options ? (options as unknown[]) : [], path)
      : null;

  let modelAnswer: unknown =
    textOrNull(raw.modelAnswer) ?? raw.modelAnswer ?? null;
  if (grading === "self") {
    const modelText = textOrNull(raw.modelAnswer);
    if (!modelText) {
      fail(`${path}.modelAnswer: مطلوب للإجابة ذاتية التقييم.`);
    }
    modelAnswer = modelText;
  } else if (grading === "auto" && textOrNull(raw.modelAnswer) === null) {
    modelAnswer = defaultModelAnswer(type, correct, options ? (options as unknown[]) : []);
  } else if (typeof modelAnswer === "object" && modelAnswer !== null) {
    modelAnswer = textOrNull(modelAnswer) ?? modelAnswer;
  }

  return {
    id,
    subjectId,
    unitId,
    lessonId,
    type,
    text,
    options,
    grading,
    correct,
    modelAnswer,
    explanation:
      typeof raw.explanation === "string" && raw.explanation.trim()
        ? raw.explanation.trim()
        : null,
    points: Math.max(
      0,
      Math.min(100, asOptionalNumber(raw.points, `${path}.points`) ?? 1),
    ),
    orderIndex: asOptionalNumber(raw.orderIndex, `${path}.orderIndex`),
    active: raw.active === undefined ? true : Boolean(raw.active),
  };
}

export function parseBankObject(
  rawInput: unknown,
  fallback: QuestionContext = {},
): ParsedBank {
  const raw = Array.isArray(rawInput) ? { questions: rawInput } : asRecord(rawInput, "الملف");
  const warnings: string[] = [];
  const subjects: BankSubjectMeta[] = [];
  const units: BankUnitMeta[] = [];
  const lessons: BankLessonMeta[] = [];

  if (raw.subjects !== undefined) {
    asArray(raw.subjects, "subjects").forEach((item, index) => {
      const subject = asRecord(item, `subjects[${index}]`);
      subjects.push({
        id: asId(subject.id, `subjects[${index}].id`),
        name: asString(subject.name, `subjects[${index}].name`),
        branches: parseBranchList(subject.branches, `subjects[${index}].branches`),
        active: subject.active === undefined ? true : Boolean(subject.active),
        sort: asOptionalNumber(subject.sort, `subjects[${index}].sort`),
      });
    });
  }

  if (raw.units !== undefined) {
    asArray(raw.units, "units").forEach((item, index) => {
      const unit = asRecord(item, `units[${index}]`);
      units.push({
        id: asId(unit.id, `units[${index}].id`),
        subjectId: asId(unit.subjectId, `units[${index}].subjectId`),
        title: asString(unit.title, `units[${index}].title`),
        sort: asOptionalNumber(unit.sort, `units[${index}].sort`),
      });
    });
  }

  if (raw.lessons !== undefined) {
    asArray(raw.lessons, "lessons").forEach((item, index) => {
      const lesson = asRecord(item, `lessons[${index}]`);
      lessons.push({
        id: asId(lesson.id, `lessons[${index}].id`),
        subjectId: asId(lesson.subjectId, `lessons[${index}].subjectId`),
        unitId: asId(lesson.unitId, `lessons[${index}].unitId`),
        title: asString(lesson.title, `lessons[${index}].title`),
        sort: asOptionalNumber(lesson.sort, `lessons[${index}].sort`),
      });
    });
  }

  const rawQuestions =
    raw.questions === undefined
      ? []
      : Array.isArray(raw.questions)
        ? raw.questions
        : [raw.questions];

  const seenIds = new Set<string>();
  const seenOrders = new Map<string, Set<number>>();
  const questions = rawQuestions.map((item, index) => {
    const question = normalizeQuestion(asRecord(item, `questions[${index}]`), fallback, index);
    if (seenIds.has(question.id)) {
      fail(`questions[${index}].id: المعرّف مكرر (${question.id}).`);
    }
    seenIds.add(question.id);
    if (question.orderIndex !== undefined) {
      const orders = seenOrders.get(question.subjectId) ?? new Set<number>();
      if (orders.has(question.orderIndex)) {
        fail(`questions[${index}].orderIndex: مكرر داخل المادة ${question.subjectId}.`);
      }
      orders.add(question.orderIndex);
      seenOrders.set(question.subjectId, orders);
    }
    return question;
  });

  if (questions.length === 0 && units.length === 0 && lessons.length === 0) {
    fail("الملف لا يحتوي على أسئلة أو وحدات أو دروس.");
  }
  if (questions.some((question) => question.orderIndex === undefined)) {
    warnings.push("الأسئلة التي بلا orderIndex ستُضاف تلقائيًا في نهاية المادة.");
  }

  return { subjects, units, lessons, questions, warnings };
}

export function parseBankText(
  text: string,
  fallback: QuestionContext = {},
): ParsedBank {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : "";
    fail(`ملف JSON غير صالح. ${detail}`);
  }
  return parseBankObject(raw, fallback);
}

const TYPE_ALIASES: Record<string, QuestionType> = {
  mcq: "mcq",
  اختيار: "mcq",
  اختيارمنمتعدد: "mcq",
  اختيارمتعدد: "mcq",
  truefalse: "true_false",
  صحخطأ: "true_false",
  صحوخطأ: "true_false",
  fillblank: "fill_blank",
  فراغ: "fill_blank",
  إكمال: "fill_blank",
  اكمال: "fill_blank",
  matching: "matching",
  مطابقة: "matching",
  ordering: "ordering",
  ترتيب: "ordering",
  comparison: "comparison",
  مقارنة: "comparison",
  shortanswer: "short_answer",
  إجابةقصيرة: "short_answer",
  اجابةقصيرة: "short_answer",
  essay: "essay",
  مقال: "essay",
};

const KEY_ALIASES: Record<string, string> = {
  سؤال: "text",
  السؤال: "text",
  نص: "text",
  النص: "text",
  text: "text",
  question: "text",
  q: "text",
  نوع: "type",
  النوع: "type",
  type: "type",
  خيارات: "options",
  الخيارات: "options",
  options: "options",
  choices: "options",
  إجابة: "answer",
  الإجابة: "answer",
  الاجابة: "answer",
  answer: "answer",
  correct: "answer",
  نموذج: "answer",
  الإجابةالنموذجية: "answer",
  الاجابةالنموذجية: "answer",
  model: "answer",
  modelanswer: "answer",
  شرح: "explanation",
  الشرح: "explanation",
  explanation: "explanation",
  note: "explanation",
  نقاط: "points",
  النقاط: "points",
  درجة: "points",
  الدرجة: "points",
  points: "points",
  ترتيب: "order",
  الترتيب: "order",
  order: "order",
  orderindex: "order",
};

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[\s_:：-]/g, "");
}

function splitOptions(value: string): string[] {
  return value
    .split(/[|؛;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function answerIndex(value: string): number {
  const normalized = value.trim().toLowerCase();
  const letterMap: Record<string, number> = {
    "0": 0,
    "1": 0,
    "2": 1,
    "3": 2,
    "4": 3,
    "5": 4,
    "6": 5,
    a: 0,
    b: 1,
    c: 2,
    d: 3,
    e: 4,
    f: 5,
    أ: 0,
    ا: 0,
    ب: 1,
    ج: 2,
    د: 3,
    هـ: 4,
    ه: 4,
    و: 5,
  };
  return letterMap[normalized] ?? Number(normalized) - 1;
}

export function parseQuickQuestions(
  text: string,
  fallback: QuestionContext = {},
): ParsedBank {
  const blocks = text
    .split(/^\s*---+\s*$/m)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length === 0) fail("اكتب سؤالًا واحدًا على الأقل.");

  const questions = blocks.map((block, index) => {
    const fields: Record<string, string> = {};
    let currentKey: string | null = null;

    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*([^:：]{1,30})\s*[:：]\s*(.*)$/);
      if (match) {
        const key = KEY_ALIASES[normalizeKey(match[1])];
        if (key) {
          fields[key] = match[2].trim();
          currentKey = key;
          continue;
        }
      }
      if (currentKey) {
        fields[currentKey] = `${fields[currentKey]}\n${line}`.trim();
      } else {
        fields.text = `${fields.text ?? ""}\n${line}`.trim();
      }
    }

    const textValue = String(fields.text ?? "").trim();
    if (!textValue) fail(`السؤال ${index + 1}: اكتب نص السؤال بعد "سؤال:".`);

    const options = fields.options ? splitOptions(fields.options) : [];
    const rawType = fields.type ? normalizeKey(fields.type) : "";
    let type = TYPE_ALIASES[rawType];
    if (!type) {
      if (options.length > 0) type = "mcq";
      else if (/^(صح|خطأ|خطا|true|false)$/i.test(String(fields.answer ?? "").trim())) {
        type = "true_false";
      } else {
        fail(`السؤال ${index + 1}: حدد النوع، مثل "نوع: mcq" أو "نوع: مقال".`);
      }
    }

    const answer = String(fields.answer ?? "").replace(/\\n/g, "\n").trim();
    const raw: Record<string, unknown> = {
      type,
      text: textValue,
      options,
      active: true,
      points: fields.points,
      orderIndex: fields.order,
      explanation: fields.explanation,
    };

    if (type === "mcq") {
      if (options.length < 2) {
        fail(`السؤال ${index + 1}: أضف خيارين على الأقل مفصولين بـ |.`);
      }
      const indexValue = answerIndex(answer);
      if (!Number.isInteger(indexValue) || indexValue < 0 || indexValue >= options.length) {
        fail(`السؤال ${index + 1}: الإجابة يجب أن تكون رقم خيار صحيحًا (1 = الخيار الأول).`);
      }
      raw.correct = { index: indexValue };
      raw.modelAnswer = options[indexValue];
    } else if (type === "true_false") {
      raw.correct = { value: answer };
      raw.modelAnswer = answer;
    } else if (type === "fill_blank") {
      if (!answer) fail(`السؤال ${index + 1}: اكتب إجابة الفراغ.`);
      raw.correct = { text: answer };
      raw.modelAnswer = answer;
    } else {
      if (!answer) fail(`السؤال ${index + 1}: اكتب الإجابة النموذجية.`);
      raw.modelAnswer = answer;
    }

    return raw;
  });

  return parseBankObject({ questions }, fallback);
}

interface WriteOperation {
  ref: ReturnType<typeof doc>;
  data: DocumentData;
  merge: boolean;
}

async function commitWrites(operations: WriteOperation[]): Promise<void> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = writeBatch(db);
    for (const operation of operations.slice(offset, offset + 400)) {
      const data = Object.fromEntries(
        Object.entries(operation.data).filter(([, value]) => value !== undefined),
      );
      batch.set(operation.ref, data, { merge: operation.merge });
    }
    await batch.commit();
  }
}

async function nextOrderIndexes(questions: BankQuestion[]): Promise<Map<string, number>> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const starts = new Map<string, number>();
  const subjects = [...new Set(questions.filter((item) => item.orderIndex === undefined).map((item) => item.subjectId))];
  for (const subjectId of subjects) {
    let start = 0;
    try {
      const snap = await getDocs(
        query(
          collection(db, "questions"),
          where("subjectId", "==", subjectId),
          where("active", "==", true),
          orderBy("orderIndex", "desc"),
          limit(1),
        ),
      );
      if (!snap.empty) start = Number(snap.docs[0].data().orderIndex ?? 0) + 1;
    } catch {
      start = Date.now();
    }
    starts.set(subjectId, start);
  }
  return starts;
}

async function countSubjectQuestions(subjectId: string): Promise<number> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const snap = await getCountFromServer(
    query(
      collection(db, "questions"),
      where("subjectId", "==", subjectId),
      where("active", "==", true),
    ),
  );
  return snap.data().count;
}

async function countUnitQuestions(subjectId: string, unitId: string): Promise<number> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const snap = await getCountFromServer(
    query(
      collection(db, "questions"),
      where("subjectId", "==", subjectId),
      where("unitId", "==", unitId),
      where("active", "==", true),
    ),
  );
  return snap.data().count;
}

async function refreshEnrollments(subjectId: string, totalQuestions: number): Promise<number> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const settings = await fetchSubjectSettings(subjectId);
  const masteryTarget = Math.ceil(totalQuestions * settings.masteryThreshold);
  const snap = await getDocs(
    query(collection(db, "enrollments"), where("subjectId", "==", subjectId)),
  );
  const active = snap.docs.filter((item) => item.data().completedAt == null);
  if (active.length === 0) return 0;
  for (let offset = 0; offset < active.length; offset += 400) {
    const batch = writeBatch(db);
    for (const item of active.slice(offset, offset + 400)) {
      batch.update(item.ref, { totalQuestions, masteryTarget });
    }
    await batch.commit();
  }
  return active.length;
}

export async function refreshSubjectTotals(
  subjectId: string,
  unitId?: string,
  options: { updateEnrollments?: boolean } = {},
): Promise<{ total: number; unitTotal?: number; enrollmentsUpdated: number }> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const total = await countSubjectQuestions(subjectId);
  const operations: WriteOperation[] = [
    {
      ref: doc(db, "subjects", subjectId),
      data: { totalQuestions: total, updatedAt: serverTimestamp() },
      merge: true,
    },
  ];

  let unitTotal: number | undefined;
  if (unitId) {
    unitTotal = await countUnitQuestions(subjectId, unitId);
    const unitSnap = await getDoc(doc(db, "units", unitId));
    const title = String(unitSnap.data()?.title ?? "");
    operations.push({
      ref: doc(db, "units", unitId),
      data: { totalQuestions: unitTotal, updatedAt: serverTimestamp() },
      merge: true,
    });
    operations.push({
      ref: doc(db, "unit_totals", `${subjectId}_${unitId}`),
      data: {
        subjectId,
        unitId,
        total: unitTotal,
        title,
        updatedAt: serverTimestamp(),
      },
      merge: true,
    });
  }
  await commitWrites(operations);

  const enrollmentsUpdated =
    options.updateEnrollments === false ? 0 : await refreshEnrollments(subjectId, total);

  return { total, unitTotal, enrollmentsUpdated };
}

export async function importQuestionBank(
  parsed: ParsedBank,
  admin: Profile,
  onProgress?: (done: number, total: number) => void,
  options: { updateEnrollments?: boolean } = {},
): Promise<ImportSummary> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const starts = await nextOrderIndexes(parsed.questions);
  const usedOrders = new Map<string, Set<number>>();
  for (const question of parsed.questions) {
    const used = usedOrders.get(question.subjectId) ?? new Set<number>();
    if (question.orderIndex !== undefined) used.add(question.orderIndex);
    usedOrders.set(question.subjectId, used);
  }
  for (const question of parsed.questions) {
    if (question.orderIndex !== undefined) continue;
    const used = usedOrders.get(question.subjectId) ?? new Set<number>();
    let next = starts.get(question.subjectId) ?? 0;
    while (used.has(next)) next += 1;
    question.orderIndex = next;
    used.add(next);
    usedOrders.set(question.subjectId, used);
  }

  const operations: WriteOperation[] = [];
  parsed.subjects.forEach((subject, index) => {
    if (!db) return;
    operations.push({
      ref: doc(db, "subjects", subject.id),
      data: {
        name: subject.name,
        branches: subject.branches,
        active: subject.active,
        sort: subject.sort ?? index + 1,
        updatedAt: serverTimestamp(),
      },
      merge: true,
    });
  });
  parsed.units.forEach((unit, index) => {
    if (!db) return;
    operations.push({
      ref: doc(db, "units", unit.id),
      data: {
        subjectId: unit.subjectId,
        title: unit.title,
        sort: unit.sort ?? index + 1,
        updatedAt: serverTimestamp(),
      },
      merge: true,
    });
  });
  parsed.lessons.forEach((lesson, index) => {
    if (!db) return;
    operations.push({
      ref: doc(db, "lessons", lesson.id),
      data: {
        subjectId: lesson.subjectId,
        unitId: lesson.unitId,
        title: lesson.title,
        sort: lesson.sort ?? index + 1,
        updatedAt: serverTimestamp(),
      },
      merge: true,
    });
  });

  let processed = 0;
  for (const question of parsed.questions) {
    if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
    operations.push({
      ref: doc(db, "questions", question.id),
      data: {
        subjectId: question.subjectId,
        unitId: question.unitId,
        lessonId: question.lessonId,
        type: question.type,
        text: question.text,
        options: question.options,
        orderIndex: question.orderIndex ?? 0,
        active: question.active,
        grading: question.grading,
        correct: question.correct,
        modelAnswer: question.modelAnswer,
        explanation: question.explanation,
        points: question.points,
        updatedAt: serverTimestamp(),
        updatedBy: admin.uid,
      },
      merge: true,
    });
    if (backendMode === "functions") {
      operations.push({
        ref: doc(db, "question_answers", question.id),
        data: {
          grading: question.grading,
          correct: question.correct,
          modelAnswer: question.modelAnswer,
          explanation: question.explanation,
          updatedAt: serverTimestamp(),
        },
        merge: true,
      });
    }
    processed += 1;
    onProgress?.(processed, parsed.questions.length);
  }

  await commitWrites(operations);

  const affectedSubjects = new Set<string>();
  const affectedUnits = new Map<string, { subjectId: string; unitId: string; title: string }>();
  for (const unit of parsed.units) {
    affectedSubjects.add(unit.subjectId);
    affectedUnits.set(`${unit.subjectId}_${unit.id}`, {
      subjectId: unit.subjectId,
      unitId: unit.id,
      title: unit.title,
    });
  }
  for (const question of parsed.questions) {
    affectedSubjects.add(question.subjectId);
    const key = `${question.subjectId}_${question.unitId}`;
    if (!affectedUnits.has(key)) {
      const title = parsed.units.find((item) => item.id === question.unitId)?.title ?? "";
      affectedUnits.set(key, {
        subjectId: question.subjectId,
        unitId: question.unitId,
        title,
      });
    }
  }

  const totalWrites: WriteOperation[] = [];
  const subjectTotals = new Map<string, number>();
  for (const subjectId of affectedSubjects) {
    const total = await countSubjectQuestions(subjectId);
    subjectTotals.set(subjectId, total);
    if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
    totalWrites.push({
      ref: doc(db, "subjects", subjectId),
      data: { totalQuestions: total, updatedAt: serverTimestamp() },
      merge: true,
    });
  }
  for (const unit of affectedUnits.values()) {
    if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
    const total = await countUnitQuestions(unit.subjectId, unit.unitId);
    let title = unit.title;
    if (!title) {
      const unitSnap = await getDoc(doc(db, "units", unit.unitId));
      title = String(unitSnap.data()?.title ?? "");
    }
    totalWrites.push({
      ref: doc(db, "units", unit.unitId),
      data: { totalQuestions: total, updatedAt: serverTimestamp() },
      merge: true,
    });
    totalWrites.push({
      ref: doc(db, "unit_totals", `${unit.subjectId}_${unit.unitId}`),
      data: {
        subjectId: unit.subjectId,
        unitId: unit.unitId,
        total,
        title,
        updatedAt: serverTimestamp(),
      },
      merge: true,
    });
  }
  await commitWrites(totalWrites);

  let enrollmentsUpdated = 0;
  if (options.updateEnrollments !== false) {
    for (const [subjectId, total] of subjectTotals) {
      enrollmentsUpdated += await refreshEnrollments(subjectId, total);
    }
  }

  return {
    questions: parsed.questions.length,
    units: parsed.units.length,
    lessons: parsed.lessons.length,
    subjects: parsed.subjects.length,
    enrollmentsUpdated,
    warnings: parsed.warnings,
  };
}

export async function setQuestionActive(
  question: BankQuestion,
  active: boolean,
  admin: Profile,
): Promise<void> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  await setDoc(
    doc(db, "questions", question.id),
    {
      active,
      updatedAt: serverTimestamp(),
      updatedBy: admin.uid,
    },
    { merge: true },
  );
  await refreshSubjectTotals(question.subjectId, question.unitId);
}

export async function removeQuestion(
  question: BankQuestion,
  admin: Profile,
): Promise<void> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");

  // An open stage stores only question ids. Deleting one of its questions
  // would make that stage impossible to resume or submit. Deactivate it
  // instead; the student can finish the current stage, then it can be removed.
  const openStages = await getDocs(
    query(collection(db, "stage_attempts"), where("status", "==", "in_progress")),
  );
  const inUse = openStages.docs.some((item) => {
    const data = item.data();
    if (data.subjectId !== question.subjectId) return false;
    return ((data.items ?? []) as Array<{ questionId?: string }>).some(
      (stageItem) => stageItem.questionId === question.id,
    );
  });
  if (inUse) {
    throw new Error(
      "هذا السؤال داخل مرحلة مفتوحة لطالب الآن. عطّله بدل حذفه، ثم احذفه بعد أن يكمل الطالب المرحلة.",
    );
  }

  await deleteDoc(doc(db, "questions", question.id));
  if (backendMode === "functions") {
    await deleteDoc(doc(db, "question_answers", question.id)).catch(() => undefined);
  }

  // Remove stale spaced-repetition rows so a deleted question cannot be
  // selected for review later.
  try {
    for (let round = 0; round < 10; round += 1) {
      const progressSnap = await getDocs(
        query(
          collection(db, "progress"),
          where("questionId", "==", question.id),
          limit(400),
        ),
      );
      if (progressSnap.empty) break;
      const batch = writeBatch(db);
      for (const item of progressSnap.docs) batch.delete(item.ref);
      await batch.commit();
      if (progressSnap.size < 400) break;
    }
  } catch {
    // The bank write already succeeded; stale progress can be cleaned later.
  }

  await refreshSubjectTotals(question.subjectId, question.unitId);
  void admin;
}

export async function fetchQuestionsForScope(
  subjectId: string,
  unitId?: string,
  lessonId?: string,
): Promise<Array<Record<string, unknown>>> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const constraints: QueryConstraint[] = [where("subjectId", "==", subjectId)];
  if (unitId) constraints.push(where("unitId", "==", unitId));
  if (lessonId) constraints.push(where("lessonId", "==", lessonId));
  const snap = await getDocs(query(collection(db, "questions"), ...constraints));
  return snap.docs
    .map((item): Record<string, unknown> => ({ id: item.id, ...item.data() }))
    .sort((a, b) => {
      const order = Number(a.orderIndex ?? 0) - Number(b.orderIndex ?? 0);
      return order || String(a.id).localeCompare(String(b.id));
    });
}

export function buildBankTemplate(input: {
  subject: Subject;
  units: Array<{ id: string; subjectId: string; title: string; sort?: number }>;
  lessons: Array<{ id: string; subjectId: string; unitId: string; title: string; sort?: number }>;
  unitId?: string;
  lessonId?: string;
}): Record<string, unknown> {
  const units = input.unitId
    ? input.units.filter((unit) => unit.id === input.unitId)
    : input.units;
  const lessons = input.lessonId
    ? input.lessons.filter((lesson) => lesson.id === input.lessonId)
    : input.unitId
      ? input.lessons.filter((lesson) => lesson.unitId === input.unitId)
      : input.lessons;

  const sampleUnitId = units[0]?.id ?? input.unitId ?? `${input.subject.id}-u1`;
  const sampleLessonId =
    lessons[0]?.id ?? input.lessonId ?? `${input.subject.id}-u1-l1`;

  return {
    format: "bakaloriastages-bank",
    version: 1,
    subjects: [
      {
        id: input.subject.id,
        name: input.subject.name,
        branches: input.subject.branches,
        active: input.subject.active,
        sort: input.subject.sort ?? 1,
      },
    ],
    units: units.map((unit) => ({
      id: unit.id,
      subjectId: unit.subjectId,
      title: unit.title,
      sort: unit.sort,
    })),
    lessons: lessons.map((lesson) => ({
      id: lesson.id,
      subjectId: lesson.subjectId,
      unitId: lesson.unitId,
      title: lesson.title,
      sort: lesson.sort,
    })),
    questions: [],
    examples: [
      {
        id: `${sampleLessonId}-q-example-mcq`,
        subjectId: input.subject.id,
        unitId: sampleUnitId,
        lessonId: sampleLessonId,
        type: "mcq",
        text: "نص السؤال هنا...",
        options: ["الخيار الأول", "الخيار الثاني", "الخيار الثالث", "الخيار الرابع"],
        correct: { index: 0 },
        modelAnswer: "الخيار الأول",
        explanation: "شرح اختياري يظهر بعد التسليم.",
        grading: "auto",
        points: 1,
        orderIndex: 10000,
        active: true,
      },
      {
        id: `${sampleLessonId}-q-example-tf`,
        subjectId: input.subject.id,
        unitId: sampleUnitId,
        lessonId: sampleLessonId,
        type: "true_false",
        text: "العبارة التي تريد الحكم عليها.",
        correct: { value: true },
        modelAnswer: "صح",
        grading: "auto",
        points: 1,
        orderIndex: 10001,
        active: true,
      },
      {
        id: `${sampleLessonId}-q-example-fill`,
        subjectId: input.subject.id,
        unitId: sampleUnitId,
        lessonId: sampleLessonId,
        type: "fill_blank",
        text: "أكمل الفراغ: ...............",
        correct: { text: "الإجابة" },
        modelAnswer: "الإجابة",
        grading: "auto",
        points: 1,
        orderIndex: 10002,
        active: true,
      },
      {
        id: `${sampleLessonId}-q-example-self`,
        subjectId: input.subject.id,
        unitId: sampleUnitId,
        lessonId: sampleLessonId,
        type: "short_answer",
        text: "اكتب إجابة قصيرة عن السؤال.",
        modelAnswer: "ضع هنا الإجابة النموذجية الكاملة التي سيقارن بها الطالب.",
        explanation: "شرح اختياري.",
        grading: "self",
        points: 2,
        orderIndex: 10003,
        active: true,
      },
    ],
    notes: [
      "أضف أسئلتك داخل المصفوفة questions فقط، ويمكن حذف examples بالكامل.",
      "orderIndex اختياري؛ إذا حذفته سيضيفه التطبيق في نهاية المادة.",
      "يمكن استعمال النوع matching أو ordering أو comparison أو essay مع grading: self.",
    ],
  };
}
