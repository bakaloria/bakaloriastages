#!/usr/bin/env python3
"""
محاكاة خطة تغطية كل أسئلة المادة (ختم المنهاج) مع سقف أسئلة لكل مرحلة.

الفرق عن simulate_stage_plan.py:
- هناك لم يكن الهدف تغطية كل سؤال، بل سؤال جديد + مراجعة.
- هنا الهدف: 100% من أسئلة المادة يجب أن تظهر، مع مراجعة وجلسات.

الاستخدام:
  python3 tools/simulate_coverage_plan.py \
      --data "/root/chat/inbox/Quizplateform-main/data/history.json" \
      --out "COVERAGE-PLAN-ar.md"
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

SECONDS_PER_QUESTION = 20
MASTERY_RETRY = 1.5  # متوسط محاولات إضافية لبلوغ الإتقان (تقديري)


def counts(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    total = 0
    auto = 0
    mcq_tf = 0
    for unit in data.get("units", []):
        for lesson in unit.get("lessons", []):
            for q in lesson.get("questions", []):
                total += 1
                if q.get("type") in {
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
                }:
                    auto += 1
                if q.get("type") in {"mcq", "true_false"}:
                    mcq_tf += 1
    return {"total": total, "auto": auto, "mcq_tf": mcq_tf}


def plan(
    n_questions: int,
    stage_size: int,
    new_ratio: float,
    session_stages: int,
    interval_minutes: int,
    retry: float = 1.0,
) -> dict:
    new_per_stage = max(1, math.floor(stage_size * new_ratio))
    stages = math.ceil(n_questions / new_per_stage)
    sessions = math.ceil(stages / session_stages)
    answers = math.ceil(stages * stage_size * retry)
    solve_h = answers * SECONDS_PER_QUESTION / 3600
    wait_h = sessions * interval_minutes / 60
    total_h = solve_h + wait_h
    return {
        "n": n_questions,
        "stage_size": stage_size,
        "new_ratio": new_ratio,
        "new_per_stage": new_per_stage,
        "stages": stages,
        "session_stages": session_stages,
        "sessions": sessions,
        "answers": answers,
        "solve_h": solve_h,
        "wait_h": wait_h,
        "total_h": total_h,
        "days": total_h / 24,
    }


def table_row(p: dict, label: str) -> str:
    return (
        f"| {label} | {p['stage_size']} | {p['new_per_stage']} | {p['stages']:,} | "
        f"{p['session_stages']} | {p['sessions']:,} | {p['answers']:,} | "
        f"{p['solve_h']:.1f} | {p['wait_h']:.0f} | **{p['days']:.1f}** |"
    )


def render(c: dict, interval: int = 120) -> str:
    lines: list[str] = []
    lines.append("# خطة تغطية كل الأسئلة (ختم المنهاج) — التاريخ")
    lines.append("")
    lines.append(
        "> الهدف: أن يظهر **كل سؤال** في المادة مرة واحدة على الأقل، "
        "مع عرض الإجابة النموذجية بعد كل سؤال، وإعادة السؤال للمراجعة حتى يثبت."
    )
    lines.append("")
    lines.append("## 1. حجم البنك")
    lines.append("")
    lines.append(f"- كل الأسئلة: **{c['total']:,}**")
    lines.append(f"- القابلة للتصحيح الآلي: **{c['auto']:,}**")
    lines.append(f"- اختيار من متعدد + صح/خطأ فقط: **{c['mcq_tf']:,}**")
    lines.append("")
    lines.append(
        "ملاحظة: بقية الأسئلة إجابة قصيرة/مقالية/مطابقة/ترتيب، وتحتاج "
        "تقييماً ذاتياً أو يدوياً. لذلك يوجد مسارَان: مسار آلي للمسابقة، "
        "ومسار كامل للختم."
    )
    lines.append("")

    lines.append("## 2. المعادلات")
    lines.append("")
    lines.append("- عدد المراحل = عدد الأسئلة ÷ عدد الأسئلة الجديدة في المرحلة.")
    lines.append("- عدد الجلسات = عدد المراحل ÷ عدد المراحل في الجلسة.")
    lines.append("- زمن الانتظار = عدد الجلسات × الفاصل الزمني.")
    lines.append("- زمن الحل = عدد الإجابات × 20 ثانية.")
    lines.append("- إن أضفنا إعادة المحاولات للإتقان، نضرب عدد الإجابات في معامل 1.5.")
    lines.append("")

    for label, n in (("MCQ + صح/خطأ", c["mcq_tf"]), ("كل الأسئلة", c["total"])):
        lines.append(f"## 3. سيناريوهات — {label} ({n:,} سؤالاً)")
        lines.append("")
        lines.append(
            "| السيناريو | سقف المرحلة | جديد/مرحلة | المراحل | مراحل/جلسة | الجلسات | الإجابات | حل (س) | انتظار (س) | أيام |"
        )
        lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
        for stage_size in (5, 10, 15, 20):
            for ratio in (0.6, 0.8, 1.0):
                for session_stages in (5, 10, 15):
                    p = plan(n, stage_size, ratio, session_stages, interval, MASTERY_RETRY)
                    label2 = (
                        f"سقف {stage_size} / جديد {int(ratio*100)}% / "
                        f"جلسة {session_stages}"
                    )
                    lines.append(table_row(p, label2))
        lines.append("")

    lines.append("## 4. السيناريو الموصى به")
    lines.append("")
    rec = plan(c["total"], 5, 0.6, 10, interval, MASTERY_RETRY)
    rec_auto = plan(c["mcq_tf"], 5, 0.6, 10, interval, MASTERY_RETRY)
    lines.append(
        f"- سقف المرحلة: **5 أسئلة** (كما اخترت).\n"
        f"- التكوين: **3 أسئلة جديدة + 2 مراجعة** (60% جديد).\n"
        f"- الجلسة: **10 مراحل = 50 سؤالاً**.\n"
        f"- الفاصل: **{interval} دقيقة** بين الجلسات، وليس بين كل مرحلة.\n"
        f"- كل الأسئلة: **{rec['stages']:,} مرحلة**، **{rec['sessions']:,} جلسة**، "
        f"نحو **{rec['days']:.0f} يوماً** مع إعادة المحاولات.\n"
        f"- MCQ/صح-خطأ فقط: **{rec_auto['stages']:,} مرحلة**، "
        f"**{rec_auto['sessions']:,} جلسة**، نحو **{rec_auto['days']:.0f} أيام**."
    )
    lines.append("")
    lines.append(
        "لماذا الجلسات؟ لأن تطبيق الفاصل بعد كل مرحلة من 5 أسئلة يعني "
        f"{rec['stages']:,} انتظاراً × {interval} دقيقة = "
        f"{rec['stages']*interval/60/24:.0f} يوماً تقريباً، وهو غير عملي."
    )
    lines.append("")

    lines.append("## 5. تعريف الختم")
    lines.append("")
    lines.append("| المستوى | الشرط | الظهور |")
    lines.append("|---|---|---|")
    lines.append("| تغطية | ظهر كل سؤال وأُجيب مرة واحدة على الأقل | شريط تغطية 100% |")
    lines.append("| إتقان | كل سؤال أُجيب صحيحاً مرة واحدة على الأقل | شريط إتقان 100% |")
    lines.append("| ختم | تغطية 100% + إتقان 100% + اجتياز الختامي | شهادة |")
    lines.append("| ختم ذهبي | كل سؤال صحيح 3 مرات متباعدة | شارة إضافية |")
    lines.append("")
    lines.append(
        "يمكن للمدير تخفيف شرط الإتقان إلى 80% أو 90% إذا كان 100% "
        "يجعل الرحلة طويلة جداً."
    )
    lines.append("")

    lines.append("## 6. الإجابة النموذجية")
    lines.append("")
    lines.append(
        "- بعد كل سؤال: تظهر إجابته، ثم **الإجابة النموذجية**، ثم الشرح إن وجد.\n"
        "- في الاختيار من متعدد: يُلوّن الخيار الصحيح، ويُعرض نص الإجابة.\n"
        "- في أكمل الفراغ: يُعرض النص النموذجي كاملاً.\n"
        "- في الإجابة القصيرة/المقالي: يُعرض النموذج، ويقيّم الطالب نفسه "
        "(صحيح/جزئي/خطأ) لأنه لا يوجد تصحيح آلي موثوق.\n"
        "- لا ينتقل الطالب قبل الضغط على «راجعت الإجابة».\n"
        "- يُضاف السؤال تلقائياً إلى قائمة المراجعة، ويعود بعد فترة."
    )
    lines.append("")

    lines.append("## 7. توصيات المحتوى")
    lines.append("")
    lines.append(
        "- 4,041 من 4,048 سؤالاً في التاريخ بلا شرح. الإجابة النموذجية موجودة، "
        "لكن الشرح غائب. يجب توليد/كتابة شرح للأسئلة الآلية على الأقل.\n"
        "- 1,594 سؤال إجابة قصيرة و30 مقالياً: تحتاج تقييماً ذاتياً أو يدوياً.\n"
        "- إن أردت مسابقة عادلة تماماً، اجعل لوحة المتصدرين للأسئلة الآلية فقط، "
        "واحتسب الأسئلة الذاتية في التغطية لا في الترتيب."
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
    parser.add_argument("--out", type=Path, default=Path("COVERAGE-PLAN-ar.md"))
    parser.add_argument("--interval", type=int, default=120)
    args = parser.parse_args()

    c = counts(args.data)
    report = render(c, args.interval)
    args.out.write_text(report, encoding="utf-8")
    print(f"تم إنشاء {args.out} ({len(report):,} حرفاً)")
    print(c)


if __name__ == "__main__":
    main()
