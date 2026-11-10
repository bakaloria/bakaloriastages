import { readFile } from "node:fs/promises";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const dryRun = args.includes("--dry-run");
const projectArg = args.find((arg) => arg.startsWith("--project="));
const projectId =
  projectArg?.slice("--project=".length) ||
  process.env.GCLOUD_PROJECT ||
  "bakaloriarace";

if (!file) {
  console.error(
    "Usage: GCLOUD_PROJECT=bakaloriarace node functions/scripts/import-bank.mjs <bank.json> [--dry-run] [--project=<id>]",
  );
  process.exit(1);
}

const QUESTION_TYPES = new Set([
  "mcq",
  "true_false",
  "fill_blank",
  "matching",
  "ordering",
  "comparison",
  "short_answer",
  "essay",
]);
const AUTO_TYPES = new Set(["mcq", "true_false", "fill_blank", "matching", "ordering"]);

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function asString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function asId(value, label) {
  const id = asString(value, label);
  if (id.includes("/")) fail(`${label} cannot contain "/".`);
  return id;
}

function asNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} must be a number.`);
  return number;
}

function asArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value;
}

function normalizeCorrect(question, type) {
  const correct = question.correct;
  if (correct === undefined || correct === null) {
    fail(`questions.${question.id}.correct is required for auto grading.`);
  }
  if (type === "mcq") {
    const index = Number(
      typeof correct === "object" && correct !== null ? correct.index : correct,
    );
    if (!Number.isInteger(index)) {
      fail(`questions.${question.id}.correct.index must be an integer.`);
    }
    const options = asArray(question.options, `questions.${question.id}.options`);
    if (index < 0 || index >= options.length) {
      fail(`questions.${question.id}.correct.index is outside the options array.`);
    }
    return { index };
  }
  if (type === "true_false") {
    const value =
      typeof correct === "object" && correct !== null ? correct.value : correct;
    if (typeof value !== "boolean") {
      fail(`questions.${question.id}.correct.value must be true or false.`);
    }
    return { value };
  }
  if (type === "fill_blank") {
    const text =
      typeof correct === "object" && correct !== null ? correct.text : correct;
    if (typeof text !== "string" || text.trim() === "") {
      fail(`questions.${question.id}.correct.text must be a non-empty string.`);
    }
    return { text };
  }
  return correct;
}

function pretty(value) {
  return JSON.stringify(value);
}

const raw = JSON.parse(await readFile(file, "utf8"));
if (!raw || typeof raw !== "object") fail("The bank file must contain a JSON object.");

const subjects = asArray(raw.subjects, "subjects");
if (subjects.length === 0) fail("subjects must contain at least one subject.");
const units = raw.units === undefined ? [] : asArray(raw.units, "units");
const lessons = raw.lessons === undefined ? [] : asArray(raw.lessons, "lessons");
const questions = raw.questions === undefined ? [] : asArray(raw.questions, "questions");

const seen = new Set();
function unique(collection, id) {
  const key = `${collection}/${id}`;
  if (seen.has(key)) fail(`Duplicate id: ${key}`);
  seen.add(key);
}

const subjectIds = new Set();
const unitIds = new Set();
const lessonIds = new Set();
const questionIds = new Set();
const orderBySubject = new Map();
const unitCounts = new Map();

for (const subject of subjects) {
  const id = asId(subject.id, "subjects[].id");
  unique("subjects", id);
  subjectIds.add(id);
}

for (const unit of units) {
  const id = asId(unit.id, "units[].id");
  const subjectId = asId(unit.subjectId, `units.${id}.subjectId`);
  if (!subjectIds.has(subjectId)) {
    fail(`units.${id}.subjectId references unknown subject "${subjectId}".`);
  }
  unique("units", id);
  unitIds.add(id);
}

for (const lesson of lessons) {
  const id = asId(lesson.id, "lessons[].id");
  const subjectId = asId(lesson.subjectId, `lessons.${id}.subjectId`);
  const unitId = asId(lesson.unitId, `lessons.${id}.unitId`);
  if (!subjectIds.has(subjectId)) {
    fail(`lessons.${id}.subjectId references unknown subject "${subjectId}".`);
  }
  if (!unitIds.has(unitId)) {
    fail(`lessons.${id}.unitId references unknown unit "${unitId}".`);
  }
  unique("lessons", id);
  lessonIds.add(id);
}

const questionWrites = [];
const answerWrites = [];

for (const question of questions) {
  const id = asId(question.id, "questions[].id");
  const subjectId = asId(question.subjectId, `questions.${id}.subjectId`);
  const unitId = asId(question.unitId, `questions.${id}.unitId`);
  const lessonId = asId(question.lessonId, `questions.${id}.lessonId`);
  const type = asString(question.type, `questions.${id}.type`);
  const text = asString(question.text, `questions.${id}.text`);
  const orderIndex = asNumber(question.orderIndex, `questions.${id}.orderIndex`);

  if (!subjectIds.has(subjectId)) {
    fail(`questions.${id}.subjectId references unknown subject "${subjectId}".`);
  }
  if (!unitIds.has(unitId)) {
    fail(`questions.${id}.unitId references unknown unit "${unitId}".`);
  }
  if (!lessonIds.has(lessonId)) {
    fail(`questions.${id}.lessonId references unknown lesson "${lessonId}".`);
  }
  if (!QUESTION_TYPES.has(type)) {
    fail(`questions.${id}.type is not supported: ${type}`);
  }
  if (!Number.isInteger(orderIndex) || orderIndex < 0) {
    fail(`questions.${id}.orderIndex must be a non-negative integer.`);
  }

  const orders = orderBySubject.get(subjectId) ?? new Set();
  if (orders.has(orderIndex)) {
    fail(`questions.${id}.orderIndex ${orderIndex} is duplicated in "${subjectId}".`);
  }
  orders.add(orderIndex);
  orderBySubject.set(subjectId, orders);

  const grading =
    question.grading === undefined
      ? AUTO_TYPES.has(type)
        ? "auto"
        : "self"
      : asString(question.grading, `questions.${id}.grading`);
  if (!["auto", "self", "manual"].includes(grading)) {
    fail(`questions.${id}.grading must be auto, self, or manual.`);
  }
  if (grading === "auto" && !AUTO_TYPES.has(type)) {
    fail(`questions.${id}.type "${type}" cannot be auto-graded. Use self or manual.`);
  }

  let options = null;
  if (type === "mcq") {
    options = asArray(question.options, `questions.${id}.options`);
    if (options.length < 2) fail(`questions.${id}.options must have at least two choices.`);
  } else if (question.options !== undefined && question.options !== null) {
    options = question.options;
  }

  const correct = grading === "auto" ? normalizeCorrect(question, type) : null;
  let modelAnswer = question.modelAnswer ?? null;
  if (grading === "auto") {
    // Keep the revealed answer identical to the graded answer.
    modelAnswer = correct;
  }
  if (grading === "self") {
    const modelText =
      typeof modelAnswer === "object" && modelAnswer !== null
        ? modelAnswer.text
        : modelAnswer;
    if (typeof modelText !== "string" || modelText.trim() === "") {
      fail(`questions.${id}.modelAnswer.text is required for self grading.`);
    }
    if (typeof modelAnswer === "string") modelAnswer = { text: modelAnswer.trim() };
  }

  unique("questions", id);
  questionIds.add(id);
  unitCounts.set(unitId, (unitCounts.get(unitId) ?? 0) + 1);

  questionWrites.push({
    collection: "questions",
    id,
    data: {
      subjectId,
      unitId,
      lessonId,
      type,
      text,
      options,
      orderIndex,
      active: question.active === undefined ? true : Boolean(question.active),
    },
  });
  answerWrites.push({
    collection: "question_answers",
    id,
    data: {
      grading,
      correct,
      modelAnswer,
      explanation:
        typeof question.explanation === "string" ? question.explanation : null,
    },
  });
}

const unitWrites = [];
for (const [index, unit] of units.entries()) {
  const id = asId(unit.id, "units[].id");
  const subjectId = asId(unit.subjectId, `units.${id}.subjectId`);
  unitWrites.push({
    collection: "units",
    id,
    data: {
      subjectId,
      title: asString(unit.title, `units.${id}.title`),
      sort: unit.sort === undefined ? index + 1 : asNumber(unit.sort, `units.${id}.sort`),
      totalQuestions: unitCounts.get(id) ?? 0,
    },
  });
  unitWrites.push({
    collection: "unit_totals",
    id: `${subjectId}_${id}`,
    data: {
      subjectId,
      unitId: id,
      total: unitCounts.get(id) ?? 0,
      title: asString(unit.title, `units.${id}.title`),
    },
  });
}

const lessonWrites = lessons.map((lesson, index) => {
  const id = asId(lesson.id, "lessons[].id");
  return {
    collection: "lessons",
    id,
    data: {
      subjectId: asId(lesson.subjectId, `lessons.${id}.subjectId`),
      unitId: asId(lesson.unitId, `lessons.${id}.unitId`),
      title: asString(lesson.title, `lessons.${id}.title`),
      sort: lesson.sort === undefined ? index + 1 : asNumber(lesson.sort, `lessons.${id}.sort`),
    },
  };
});

const subjectWrites = subjects.map((subject, index) => {
  const id = asId(subject.id, "subjects[].id");
  const branches = asArray(subject.branches, `subjects.${id}.branches`);
  if (branches.length === 0 || branches.some((branch) => !["scientific", "literary"].includes(branch))) {
    fail(`subjects.${id}.branches must contain scientific, literary, or both.`);
  }
  const data = {
    name: asString(subject.name, `subjects.${id}.name`),
    branches,
    active: subject.active === undefined ? true : Boolean(subject.active),
    sort: subject.sort === undefined ? index + 1 : asNumber(subject.sort, `subjects.${id}.sort`),
    totalQuestions: questionWrites.filter((item) => item.data.subjectId === id).length,
  };
  for (const key of ["slug", "icon", "color", "description"]) {
    if (typeof subject[key] === "string" && subject[key] !== "") data[key] = subject[key];
  }
  return { collection: "subjects", id, data };
});

const allWrites = [
  ...subjectWrites,
  ...unitWrites,
  ...lessonWrites,
  ...questionWrites,
  ...answerWrites,
];

console.log(`Project: ${projectId}${dryRun ? " (dry run)" : ""}`);
console.log(
  `Subjects: ${subjectWrites.length} | Units: ${unitWrites.length / 2} | Lessons: ${lessonWrites.length} | Questions: ${questionWrites.length}`,
);
console.log(
  `Writes: ${allWrites.length} (Firestore batch limit 500, will commit in chunks)`,
);
console.log("Sample question:", pretty(questionWrites[0]?.data ?? null));

if (!dryRun) {
  initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore();
  let committed = 0;
  for (let index = 0; index < allWrites.length; index += 450) {
    const batch = db.batch();
    for (const write of allWrites.slice(index, index + 450)) {
      batch.set(db.collection(write.collection).doc(write.id), write.data, {
        merge: true,
      });
    }
    await batch.commit();
    committed += Math.min(450, allWrites.length - index);
    console.log(`Committed ${committed}/${allWrites.length}`);
  }
  console.log("\n✔ Import complete.");
} else {
  console.log("\n✔ Dry run complete. Nothing was written.");
}
