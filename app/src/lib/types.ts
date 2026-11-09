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

export interface Profile {
  uid: string;
  username: string;
  usernameLower: string;
  displayName: string;
  branch: Branch;
  role: "student" | "admin";
}

export interface Subject {
  id: string;
  name: string;
  slug?: string;
  branches: Branch[];
  active: boolean;
  sort?: number;
  totalQuestions?: number;
  icon?: string;
  color?: string;
  description?: string;
}

export interface UnitProgress {
  unitId: string;
  title: string;
  total: number;
  seen: number;
  mastered: number;
}

export interface SubjectProgress {
  enrolled: boolean;
  subjectId: string;
  totalQuestions: number;
  coverageCount: number;
  masteryCount: number;
  masteryTarget: number;
  sessionStages: number;
  sessionNo: number;
  stagesInSession: number;
  nextAvailableAt: number | null;
  completedAt: number | null;
  masteryCompletedAt: number | null;
  byUnit: UnitProgress[];
}

export interface StageQuestion {
  questionId: string;
  position: number;
  isReview: boolean;
  type: QuestionType;
  text: string;
  options: unknown;
}

export interface StagePayload {
  attemptId: string;
  resumed?: boolean;
  stageNo: number;
  sessionNo: number;
  stageInSession: number;
  sessionStages: number;
  questions: StageQuestion[];
}

export interface StageLocked {
  locked: true;
  nextAvailableAt: number;
  sessionNo?: number;
  stagesInSession?: number;
}

export interface StageFeedbackRequired {
  feedbackRequired: true;
  attemptId: string;
}

export interface StageCompleted {
  completed: true;
  totalQuestions: number;
  coverageCount: number;
  masteryCount: number;
  masteryTarget: number;
}

export interface StageAlreadySubmitted {
  attemptId: string;
  alreadySubmitted: true;
  feedbackSeen: boolean;
}

export type StartStageResponse =
  | StagePayload
  | StageLocked
  | StageFeedbackRequired
  | StageCompleted
  | StageAlreadySubmitted;

export interface GradedAnswer {
  questionId: string;
  answer?: unknown;
  selfScore?: SelfScore | null;
  timeMs?: number;
  isCorrect: boolean | null;
  grading: Grading;
  modelAnswer: unknown;
  explanation: string | null;
  text: string;
  type: QuestionType;
  options?: unknown;
}

export interface SubmitStageResponse {
  attemptId: string;
  score: number;
  results: GradedAnswer[];
  sessionComplete: boolean;
  nextAvailableAt: number | null;
  totalQuestions: number;
  coverageCount: number;
  masteryCount: number;
  masteryTarget: number;
}

export interface StageResultResponse {
  attemptId: string;
  score: number;
  results: GradedAnswer[];
  sessionComplete: boolean;
  nextAvailableAt: number | null;
  feedbackSeen: boolean;
}

export interface LeaderboardRow {
  rank: number;
  userId: string;
  displayName: string;
  autoFirstCorrect: number;
  masteryCount: number;
  coverageCount: number;
  totalQuestions: number;
  completedAt: number | null;
}

export interface Certificate {
  userId: string;
  subjectId: string;
  displayName: string;
  coverageCount: number;
  masteryCount: number;
  totalQuestions: number;
  code: string;
  issuedAt: number | { seconds: number; nanoseconds: number } | null;
}

export interface RegisterInput {
  username: string;
  password: string;
  displayName: string;
  branch: Branch;
}
