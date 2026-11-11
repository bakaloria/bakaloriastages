import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { Countdown } from "../components/Countdown";
import { EmptyState } from "../components/EmptyState";
import { ChevronLeftIcon, ClockIcon, SparklesIcon } from "../components/Icons";
import { InlineLoader } from "../components/Loading";
import { ProgressRing } from "../components/ProgressRing";
import { useAuth } from "../context/AuthContext";
import { db } from "../lib/firebase";
import {
  branchLabel,
  formatNumber,
  formatPercent,
  progressRatio,
  toMillis,
} from "../lib/format";
import type { Subject } from "../lib/types";

interface EnrollmentRow {
  id: string;
  subjectId: string;
  totalQuestions: number;
  coverageCount: number;
  masteryCount: number;
  masteryTarget: number;
  sessionStages: number;
  sessionNo: number;
  stagesInSession: number;
  nextAvailableAt: unknown;
  completedAt: unknown;
}

export function ProgressPage() {
  const { profile, user, settings } = useAuth();
  const [subjects, setSubjects] = useState<Record<string, Subject>>({});
  const [enrollments, setEnrollments] = useState<EnrollmentRow[]>([]);
  const [loading, setLoading] = useState(true);

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
        const map: Record<string, Subject> = {};
        for (const doc of snapshot.docs) {
          map[doc.id] = { id: doc.id, ...(doc.data() as Omit<Subject, "id">) };
        }
        setSubjects(map);
      },
      () => undefined,
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
        setEnrollments(
          snapshot.docs.map((doc) => {
            const data = doc.data();
            return {
              id: doc.id,
              subjectId: String(data.subjectId),
              totalQuestions: Number(data.totalQuestions ?? 0),
              coverageCount: Number(data.coverageCount ?? 0),
              masteryCount: Number(data.masteryCount ?? 0),
              masteryTarget: Number(data.masteryTarget ?? data.totalQuestions ?? 0),
              sessionStages: Number(data.sessionStages ?? 10),
              sessionNo: Number(data.sessionNo ?? 1),
              stagesInSession: Number(data.stagesInSession ?? 0),
              nextAvailableAt: data.nextAvailableAt,
              completedAt: data.completedAt,
            };
          }),
        );
        setLoading(false);
      },
      () => setLoading(false),
    );
  }, [user]);

  const totals = useMemo(
    () => ({
      coverage: enrollments.reduce((sum, row) => sum + row.coverageCount, 0),
      mastery: enrollments.reduce((sum, row) => sum + row.masteryCount, 0),
      questions: enrollments.reduce((sum, row) => sum + row.totalQuestions, 0),
    }),
    [enrollments],
  );

  return (
    <div className="page progress-page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">
            <SparklesIcon />
            {branchLabel(profile?.branch)}
          </span>
          <h1>تقدمي</h1>
          <p>نظرة شاملة على المواد التي انضممت إليها، والتغطية والإتقان في كل مادة.</p>
        </div>
        <ProgressRing
          value={totals.coverage}
          total={totals.questions}
          size={132}
          label="إجمالي التغطية"
          sublabel={`${formatNumber(totals.coverage)} / ${formatNumber(totals.questions)}`}
        />
      </section>

      <div className="stats-grid stats-grid--three">
        <div className="stat-card">
          <span className="stat-card__label">المواد المنضم إليها</span>
          <strong>{formatNumber(enrollments.length)}</strong>
          <small>من أصل {formatNumber(Object.keys(subjects).length)} مادة متاحة</small>
        </div>
        <div className="stat-card">
          <span className="stat-card__label">أسئلة مغطاة</span>
          <strong>{formatNumber(totals.coverage)}</strong>
          <small>كل سؤال مرّ عليك مرة على الأقل</small>
        </div>
        <div className="stat-card">
          <span className="stat-card__label">أسئلة متقنة</span>
          <strong>{formatNumber(totals.mastery)}</strong>
          <small>أجبت عنها إجابة صحيحة</small>
        </div>
      </div>

      {loading ? (
        <InlineLoader label="نحمّل تقدمك..." />
      ) : enrollments.length === 0 ? (
        <EmptyState
          title="لم تنضم إلى أي مادة بعد"
          description="اختر مادة من الصفحة الرئيسية وابدأ المرحلة الأولى."
          action={<Link to="/" className="button button--primary">اختر مادة</Link>}
        />
      ) : (
        <div className="progress-list">
          {enrollments.map((row) => {
            const subject = subjects[row.subjectId];
            const nextAvailableAt = toMillis(row.nextAvailableAt);
            const locked = Boolean(nextAvailableAt && nextAvailableAt > Date.now());
            const completed = Boolean(row.completedAt);
            return (
              <Link to={`/subject/${row.subjectId}`} className="progress-card" key={row.id}>
                <div className="progress-card__icon" style={{ background: subject?.color || undefined }}>
                  {subject?.icon || "📘"}
                </div>
                <div className="progress-card__body">
                  <div className="progress-card__heading">
                    <div>
                      <h3>{subject?.name || row.subjectId}</h3>
                      <span className="muted small">
                        الجلسة {formatNumber(row.sessionNo)} • {formatNumber(row.stagesInSession)} / {formatNumber(row.sessionStages)} مراحل
                      </span>
                    </div>
                    <span className={`badge ${completed ? "badge--green" : locked ? "badge--gold" : "badge--soft"}`}>
                      {completed ? "مكتملة" : locked ? "فاصل الجلسة" : "قيد التقدم"}
                    </span>
                  </div>

                  <div className="progress-card__bars">
                    <div>
                      <div className="progress-bar"><span style={{ width: `${Math.round(progressRatio(row.coverageCount, row.totalQuestions) * 100)}%` }} /></div>
                      <div className="progress-card__meta">
                        <span>تغطية {formatPercent(row.coverageCount, row.totalQuestions)}</span>
                        <span>{formatNumber(row.coverageCount)} / {formatNumber(row.totalQuestions)}</span>
                      </div>
                    </div>
                    <div>
                      <div className="progress-bar progress-bar--gold"><span style={{ width: `${Math.round(progressRatio(row.masteryCount, row.totalQuestions) * 100)}%` }} /></div>
                      <div className="progress-card__meta">
                        <span>إتقان {formatPercent(row.masteryCount, row.totalQuestions)}</span>
                        <span>{formatNumber(row.masteryCount)} / {formatNumber(row.masteryTarget)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="progress-card__footer">
                    {locked ? (
                      <span className="inline-meta"><ClockIcon /> التالي بعد <Countdown target={nextAvailableAt} /></span>
                    ) : (
                      <span className="inline-meta">
                        <SparklesIcon />{" "}
                        {completed
                          ? settings.certificateClaimsEnabled
                            ? "عرض شهادتك"
                            : "راجع سجل إتمامك"
                          : "تابع المرحلة التالية"}
                      </span>
                    )}
                    <ChevronLeftIcon />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
