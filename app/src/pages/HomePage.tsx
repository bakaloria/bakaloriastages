import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { AnnouncementBanner } from "../components/AnnouncementBanner";
import { Countdown } from "../components/Countdown";
import { EmptyState } from "../components/EmptyState";
import { ChevronLeftIcon, ClockIcon, SparklesIcon, TrophyIcon } from "../components/Icons";
import { InlineLoader } from "../components/Loading";
import { ProgressRing } from "../components/ProgressRing";
import { useAuth } from "../context/AuthContext";
import { db } from "../lib/firebase";
import { branchLabel, formatNumber, formatPercent, progressRatio, toMillis } from "../lib/format";
import type { Subject } from "../lib/types";

interface EnrollmentRow {
  subjectId: string;
  totalQuestions: number;
  coverageCount: number;
  masteryCount: number;
  nextAvailableAt?: unknown;
  completedAt?: unknown;
}

export function HomePage() {
  const { profile, user } = useAuth();
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [enrollments, setEnrollments] = useState<Record<string, EnrollmentRow>>({});
  const [loadingSubjects, setLoadingSubjects] = useState(true);
  const [loadingEnrollments, setLoadingEnrollments] = useState(true);

  useEffect(() => {
    if (!db || !profile) return;
    const subjectsQuery = query(
      collection(db, "subjects"),
      where("branches", "array-contains", profile.branch),
      where("active", "==", true),
      orderBy("sort", "asc"),
    );
    return onSnapshot(
      subjectsQuery,
      (snapshot) => {
        setSubjects(
          snapshot.docs.map((doc) => ({
            id: doc.id,
            ...(doc.data() as Omit<Subject, "id">),
          })),
        );
        setLoadingSubjects(false);
      },
      () => setLoadingSubjects(false),
    );
  }, [profile]);

  useEffect(() => {
    if (!db || !user) return;
    const enrollmentsQuery = query(
      collection(db, "enrollments"),
      where("userId", "==", user.uid),
    );
    return onSnapshot(
      enrollmentsQuery,
      (snapshot) => {
        const rows: Record<string, EnrollmentRow> = {};
        for (const doc of snapshot.docs) {
          const data = doc.data();
          rows[String(data.subjectId)] = {
            subjectId: String(data.subjectId),
            totalQuestions: Number(data.totalQuestions ?? 0),
            coverageCount: Number(data.coverageCount ?? 0),
            masteryCount: Number(data.masteryCount ?? 0),
            nextAvailableAt: data.nextAvailableAt,
            completedAt: data.completedAt,
          };
        }
        setEnrollments(rows);
        setLoadingEnrollments(false);
      },
      () => setLoadingEnrollments(false),
    );
  }, [user]);

  const totals = useMemo(() => {
    const totalQuestions = subjects.reduce(
      (sum, subject) => sum + Number(subject.totalQuestions ?? enrollments[subject.id]?.totalQuestions ?? 0),
      0,
    );
    const covered = subjects.reduce(
      (sum, subject) => sum + Number(enrollments[subject.id]?.coverageCount ?? 0),
      0,
    );
    const mastered = subjects.reduce(
      (sum, subject) => sum + Number(enrollments[subject.id]?.masteryCount ?? 0),
      0,
    );
    return { totalQuestions, covered, mastered, count: subjects.length };
  }, [subjects, enrollments]);

  const loading = loadingSubjects || loadingEnrollments;

  return (
    <div className="page home-page">
      <AnnouncementBanner />
      <section className="home-hero">
        <div className="home-hero__content">
          <span className="eyebrow">
            <SparklesIcon />
            {branchLabel(profile?.branch)}
          </span>
          <h1>
            أهلًا، <span>{profile?.displayName}</span>
          </h1>
          <p>
            كل مرحلة تضيف أسئلة جديدة وتعید أسئلة تحتاج تثبيتًا. أكمل التغطية، واصل حتى الإتقان،
            ثم استلم شهادتك.
          </p>
          <div className="home-hero__actions">
            <Link to="/progress" className="button button--primary">
              عرض تقدمي
              <ChevronLeftIcon />
            </Link>
            <Link to="/leaderboard" className="button button--ghost">
              <TrophyIcon />
              المتصدرون
            </Link>
          </div>
        </div>

        <div className="home-hero__visual">
          <ProgressRing
            value={totals.covered}
            total={totals.totalQuestions}
            size={180}
            stroke={13}
            label="تغطية المواد"
            sublabel={`${formatNumber(totals.covered)} / ${formatNumber(totals.totalQuestions)}`}
          />
          <div className="floating-stat floating-stat--one">
            <strong>{formatNumber(totals.mastered)}</strong>
            <span>سؤالًا متقنًا</span>
          </div>
          <div className="floating-stat floating-stat--two">
            <strong>{formatNumber(totals.count)}</strong>
            <span>مواد متاحة</span>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">موادك</span>
            <h2>اختر مادة وابدأ المرحلة</h2>
          </div>
          <span className="muted small">{formatNumber(subjects.length)} مواد في فرعك</span>
        </div>

        {loading ? (
          <InlineLoader label="نحمّل المواد..." />
        ) : subjects.length === 0 ? (
          <EmptyState
            title="لا توجد مواد بعد"
            description="لم تُضف مواد لهذا الفرع حتى الآن. عُد قريبًا أو تواصل مع المشرف."
            icon={<SparklesIcon />}
          />
        ) : (
          <div className="subject-grid">
            {subjects.map((subject, index) => {
              const enrollment = enrollments[subject.id];
              const total = Number(enrollment?.totalQuestions ?? subject.totalQuestions ?? 0);
              const covered = Number(enrollment?.coverageCount ?? 0);
              const mastered = Number(enrollment?.masteryCount ?? 0);
              const ratio = progressRatio(covered, total);
              const isNew = !enrollment;
              const completed = Boolean(enrollment?.completedAt);
              const nextAt = toMillis(enrollment?.nextAvailableAt);
              const locked = Boolean(nextAt && nextAt > Date.now());

              return (
                <Link
                  key={subject.id}
                  to={`/subject/${subject.id}`}
                  className="subject-card"
                  style={{ "--subject-delay": `${index * 45}ms` } as CSSProperties}
                >
                  <div className="subject-card__top">
                    <div
                      className="subject-card__icon"
                      style={{ background: subject.color || undefined }}
                    >
                      {subject.icon || "📘"}
                    </div>
                    <span className={`badge ${isNew ? "badge--gold" : completed ? "badge--green" : "badge--soft"}`}>
                      {isNew ? "جديدة" : completed ? "مكتملة" : "قيد التقدم"}
                    </span>
                  </div>
                  <h3>{subject.name}</h3>
                  <p>{subject.description || `${formatNumber(total)} سؤالًا في انتظارك.`}</p>

                  <div className="subject-card__progress">
                    <div className="progress-bar">
                      <span style={{ width: `${Math.round(ratio * 100)}%` }} />
                    </div>
                    <div className="subject-card__meta">
                      <span>{formatPercent(covered, total)} تغطية</span>
                      <span>{formatNumber(mastered)} متقن</span>
                    </div>
                  </div>

                  <div className="subject-card__footer">
                    <span>
                      {locked && nextAt ? (
                        <>
                          <ClockIcon />
                          <Countdown target={nextAt} />
                        </>
                      ) : (
                        <>
                          <SparklesIcon />
                          {isNew ? "انضم وابدأ" : "تابع من حيث توقفت"}
                        </>
                      )}
                    </span>
                    <ChevronLeftIcon />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
