export type Branch = "scientific" | "literary";

export type QuestionType =
  | "mcq"
  | "true_false"
  | "fill_blank"
  | "matching"
  | "ordering"
  | "comparison"
  | "short_answer"
  | "essay";

export type Grading = "auto" | "self" | "manual";

export type SelfScore = "correct" | "partial" | "wrong";

export interface QuestionPublic {
  subjectId: string;
  unitId: string;
  lessonId: string;
  type: QuestionType;
  text: string;
  options?: unknown;
  orderIndex: number;
  active: boolean;
}

export interface QuestionPrivate {
  grading: Grading;
  correct?: unknown;
  modelAnswer: unknown;
  explanation?: string;
}

export interface AnswerInput {
  questionId: string;
  answer?: unknown;
  selfScore?: SelfScore;
  timeMs?: number;
}

export interface StageItem {
  questionId: string;
  position: number;
  isReview: boolean;
}

export interface SubjectSettings {
  stageSize: number;
  newPerStage: number;
  reviewPerStage: number;
  sessionStages: number;
  intervalMinutes: number;
  stageIntervalMinutes: number;
  masteryThreshold: number;
  finalExamRequired: boolean;
}

export interface SelectedQuestion {
  id: string;
  orderIndex: number;
  isReview: boolean;
}

export interface GradedAnswer {
  questionId: string;
  answer?: unknown;
  selfScore?: SelfScore;
  timeMs?: number;
  isCorrect: boolean | null;
  grading: Grading;
  modelAnswer: unknown;
  explanation: string | null;
  text: string;
  type: QuestionType;
  options?: unknown;
}
