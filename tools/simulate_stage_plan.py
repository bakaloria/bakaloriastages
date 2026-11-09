#!/usr/bin/env python3
"""
محاكاة خطة المراحل من بنك أسئلة التاريخ.

الهدف: مقارنة النموذج التراكمي الحرفي (المرحلة n = n أسئلة)
بالنموذج المقترح (سؤال جديد + حتى 4 أسئلة مراجعة = 5 كحد أقصى).

الاستخدام:
  python3 tools/simulate_stage_plan.py \
      --data "/root/chat/inbox/Quizplateform-main/data/history.json" \
      --out "STAGE-SIMULATION-ar.md"
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path

AUTO_TYPES = {
    "mcq",
    "true_false",
    "fill_blank",
    "multi",
    "matching",
    "ordering",
    "classification",
    "comparison",
    "diagram_label",
    "genetics_problem",
    "image_mcq",
}

SECONDS_PER_QUESTION = 20
REVIEW_CAP = 4
BOSS_SIZE = 20
FINAL_SIZE = 40


@dataclass
class Lesson:
    unit_no: int
    unit_title: str
    lesson_no: int
    title: str
    questions: list[dict] = field(default_factory=list)


def load_lessons(path: Path, allowed_types: set[str]) -> tuple[str, list[Lesson]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    subject = data.get("subject", "المادة")
    lessons: list[Lesson] = []
    for u_idx, unit in enumerate(data.get("units", []), start=1):
        for l_idx, lesson in enumerate(unit.get("lessons", []), start=1):
            auto = [
                q
                for q in lesson.get("questions", [])
                if q.get("type") in allowed_types
            ]
            lessons.append(
                Lesson(
                    unit_no=u_idx,
                    unit_title=unit.get("unit_title", f"الوحدة {u_idx}"),
                    lesson_no=l_idx,
                    title=lesson.get("lesson_title", f"الدرس {l_idx}"),
                    questions=auto,
                )
            )
    return subject, lessons


def build_stages(lessons: list[Lesson], cap: int | None) -> list[dict]:
    """cap=None يعني التراكم الحرفي، وإلا سقف عدد أسئلة المراجعة."""
    stages = []
    previous_new: list[dict] = []

    for idx, lesson in enumerate(lessons, start=1):
        new_q = lesson.questions[0] if lesson.questions else None
        review_count = idx - 1 if cap is None else min(idx - 1, cap)
        review = previous_new[-review_count:] if review_count else []

        stages.append(
            {
                "stage": idx,
                "unit_no": lesson.unit_no,
                "unit_title": lesson.unit_title,
                "lesson_title": lesson.title,
                "new_question": new_q,
                "review_questions": review,
                "total": (1 if new_q else 0) + len(review),
            }
        )
        if new_q:
            previous_new.append(new_q)

    return stages


def summarize(stages: list[dict], lessons: list[Lesson], interval_hours: float) -> dict:
    question_total = sum(s["total"] for s in stages)
    units = sorted({l.unit_no for l in lessons})
    boss_total = len(units) * BOSS_SIZE
    final_total = FINAL_SIZE
    served = question_total + boss_total + final_total
    waits = max(0, len(stages) - 1) * interval_hours * 3600
    solve_seconds = served * SECONDS_PER_QUESTION
    return {
        "stages": len(stages),
        "units": len(units),
        "boss_total": boss_total,
        "final_total": final_total,
        "question_total": question_total,
        "served": served,
        "last_stage_questions": stages[-1]["total"] if stages else 0,
        "waits_hours": waits / 3600,
        "solve_hours": solve_seconds / 3600,
        "total_hours": (waits + solve_seconds) / 3600,
        "new_unique": sum(1 for s in stages if s["new_question"]),
    }


def fmt_q(q: dict | None, width: int = 90) -> str:
    if not q:
        return "—"
    text = (q.get("text") or "").replace("\n", " ").strip()
    if len(text) > width:
        text = text[: width - 1] + "…"
    return f"`{q.get('type', '?')}` — {text}"


def render(
    subject: str,
    lessons: list[Lesson],
    interval_hours: float,
    allowed_types: set[str],
) -> str:
    literal = build_stages(lessons, cap=None)
    capped = build_stages(lessons, cap=REVIEW_CAP)
    lit = summarize(literal, lessons, interval_hours)
    cap = summarize(capped, lessons, interval_hours)

    lines: list[str] = []
    lines.append("# محاكاة خطة المراحل — " + subject)
    lines.append("")
    lines.append(
        "> مولّد آلياً من بنك الأسئلة الفعلي. الهدف: اختبار فكرة "
        "«سؤال جديد + مراجعة تراكمية» قبل بنائها."
    )
    lines.append("")
    lines.append("## 1. المعطيات")
    lines.append("")
    lines.append(f"- عدد الدروس (المراحل الأساسية): **{len(lessons)}**")
    lines.append(f"- عدد الوحدات: **{len({l.unit_no for l in lessons})}**")
    lines.append(f"- أنواع الأسئلة المستخدمة: **{', '.join(sorted(allowed_types))}**")
    lines.append(f"- سقف المراجعة في النموذج المقترح: **{REVIEW_CAP}** أسئلة")
    lines.append(f"- زعيم كل وحدة: **{BOSS_SIZE}** سؤالاً")
    lines.append(f"- الامتحان الختامي: **{FINAL_SIZE}** سؤالاً")
    lines.append(f"- زمن السؤال المفترض: **{SECONDS_PER_QUESTION}** ثانية")
    lines.append(f"- الفاصل بين المراحل: **{interval_hours:g}** ساعة")
    lines.append("")

    lines.append("## 2. أول 10 مراحل — النموذج المقترح (سقف 5 أسئلة)")
    lines.append("")
    lines.append("| المرحلة | الدرس | السؤال الجديد | أسئلة المراجعة | الإجمالي |")
    lines.append("|---:|---|---|---:|---:|")
    for s in capped[:10]:
        lines.append(
            f"| {s['stage']} | {s['lesson_title']} | {fmt_q(s['new_question'], 60)} | "
            f"{len(s['review_questions'])} | {s['total']} |"
        )
    lines.append("")

    lines.append("### ملاحظة على التسلسل")
    lines.append("")
    lines.append(
        "في المراحل 1–5 يتطابق النموذج المقترح مع فكرتك حرفياً: "
        "1 ← 2 ← 3 ← 4 ← 5. من المرحلة 6 يثبت عند 5 أسئلة "
        "(سؤال جديد + 4 من آخر الأسئلة السابقة) بدل أن يكبر إلى 45."
    )
    lines.append("")

    lines.append("## 3. مقارنة النموذجين")
    lines.append("")
    lines.append("| المؤشر | التراكم الحرفي | المقترح (سقف 5) |")
    lines.append("|---|---:|---:|")
    lines.append(f"| عدد أسئلة المرحلة الأخيرة | **{lit['last_stage_questions']}** | **{cap['last_stage_questions']}** |")
    lines.append(f"| مجموع أسئلة المراحل | {lit['question_total']:,} | {cap['question_total']:,} |")
    lines.append(f"| + الزعماء ({cap['units']} × {BOSS_SIZE}) | {lit['boss_total']:,} | {cap['boss_total']:,} |")
    lines.append(f"| + الامتحان الختامي | {lit['final_total']:,} | {cap['final_total']:,} |")
    lines.append(f"| إجمالي الإجابات | **{lit['served']:,}** | **{cap['served']:,}** |")
    lines.append(f"| زمن الحل (20 ث/سؤال) | {lit['solve_hours']:.1f} ساعة | {cap['solve_hours']:.1f} ساعة |")
    lines.append(f"| الانتظار ({interval_hours:g} س × {len(literal) - 1}) | {lit['waits_hours']:.0f} ساعة | {cap['waits_hours']:.0f} ساعة |")
    lines.append(f"| الزمن الكلي التقريبي | **{lit['total_hours']:.0f} ساعة** | **{cap['total_hours']:.0f} ساعة** |")
    lines.append("")

    lines.append("## 4. أثر الفاصل الزمني (النموذج المقترح)")
    lines.append("")
    lines.append("| الفاصل | زمن الانتظار الكلي | الزمن الكلي التقريبي |")
    lines.append("|---:|---:|---:|")
    for h in (1 / 6, 0.25, 0.5, 1, 2, 24):
        s = summarize(capped, lessons, h)
        label = f"{int(h * 60)} دقيقة" if h < 1 else f"{h:g} ساعة"
        lines.append(f"| {label} | {s['waits_hours']:.1f} ساعة | {s['total_hours']:.1f} ساعة |")
    lines.append("")

    lines.append("## 5. قراءة النتائج")
    lines.append("")
    lines.append(
        f"- التراكم الحرفي يجعل المرحلة الأخيرة {lit['last_stage_questions']} سؤالاً، "
        f"ويستهلك {lit['served']:,} إجابة، أي {lit['solve_hours']:.1f} ساعة حل."
    )
    lines.append(
        f"- النموذج المقترح يخفض الإجابات إلى {cap['served']:,} ويُبقي المرحلة في 5 أسئلة، "
        f"أي {cap['solve_hours']:.1f} ساعة حل."
    )
    lines.append(
        "- التغطية الجديدة تبقى سؤالاً واحداً لكل درس في المراحل، لذا يلزم "
        "زعماء الوحدات والامتحان الختامي لتغطية أوسع."
    )
    lines.append(
        f"- مع فاصل {interval_hours:g} ساعة، الزمن الكلي التقريبي {cap['total_hours']:.0f} ساعة. "
        "لذلك يجب أن تكون مدة الموسم أكبر من ذلك + هامش."
    )
    lines.append("")

    lines.append("## 6. التوصية العملية")
    lines.append("")
    lines.append(
        "1. طبّق التسلسل 1 ← 2 ← 3 ← 4 ← 5 كما في فكرتك.\n"
        "2. من المرحلة 6، ثبّت على 5 أسئلة (جديد + 4 مراجعة).\n"
        "3. اجعل سقف المراجعة إعداداً في لوحة المدير (0 = بلا مراجعة، 4 = افتراضي، 44 = تراكم كامل).\n"
        "4. أضف زعيم وحدة كل 5–8 دروس وامتحاناً ختامياً لتغطية بقية البنك.\n"
        "5. استخدم فاصل 60 دقيقة افتراضياً، واترك 120 دقيقة كخيار «سباق»."
    )
    lines.append("")

    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data",
        type=Path,
        default=Path("/root/chat/inbox/Quizplateform-main/data/history.json"),
    )
    parser.add_argument("--out", type=Path, default=Path("STAGE-SIMULATION-ar.md"))
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument(
        "--types",
        default="mcq,true_false",
        help="أنواع الأسئلة المفصولة بفواصل (الافتراضي: mcq,true_false)",
    )
    args = parser.parse_args()

    allowed_types = {t.strip() for t in args.types.split(",") if t.strip()}
    subject, lessons = load_lessons(args.data, allowed_types)
    if not lessons:
        raise SystemExit("لم يتم العثور على دروس قابلة للتصحيح الآلي.")

    report = render(subject, lessons, args.interval, allowed_types)
    args.out.write_text(report, encoding="utf-8")
    print(f"تم إنشاء {args.out} ({len(report):,} حرفاً)")
    print(f"الدروس: {len(lessons)} | الوحدات: {len({l.unit_no for l in lessons})}")


if __name__ == "__main__":
    main()
