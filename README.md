# مراحل البكالوريا — Bakaloriastages

تطبيق ويب تقدمي (PWA) عربي لطلاب البكالوريا، يقوم على مسابقة دراسية تراكمية:

- حساب طالب باسم مستخدم وكلمة مرور.
- اختيار الفرع (علمي / أدبي) والمواد المناسبة.
- كل مادة مسابقة مستقلة: أسئلة جديدة + مراجعة متباعدة.
- إجابة نموذجية بعد كل مرحلة، ولا يمكن بدء المرحلة التالية قبل الاطلاع عليها.
- تغطية كل أسئلة المادة، ثم الإتقان، ثم شهادة إتمام.
- تقدم محفوظ في Firebase (Auth + Firestore).
- لوحة مدير لإغلاق المراحل، ونشر الإعلانات، وإدارة الطلاب، وضبط أسئلة كل مرحلة.
- وضع **Spark** المجاني: التصحيح وتحديث التقدم داخل التطبيق، بلا Cloud Functions.
- وضع **Functions** الاختياري: تصحيح خادمي محصّن بعد الترقية إلى Blaze.
- وضع Spark لا يحتاج بطاقة، لكنه لا يمنع طالبًا متمكنًا من التلاعب بالدرجات والترتيب.

## الرابط

- GitHub: <https://github.com/bakaloria/bakaloriastages>
- التطبيق المباشر: <https://bakaloria.github.io/bakaloriastages/>
- Firestore: مشروع `bakaloriarace`، قاعدة `(default)` في `europe-west9`.
- النطاق `bakaloria.github.io` مضاف إلى Authorized domains في Firebase Auth.

> تم استيراد بنك الأسئلة من التطبيق السابق إلى Firestore: **6 مواد و11,901 سؤالًا**
> في 44 وحدة و407 دروس:
>
> - علم الأحياء: 2,366 سؤالًا (علمي)
> - الكيمياء: 1,347 سؤالًا (علمي)
> - الفيزياء: 1,384 سؤالًا (علمي)
> - اللغة الإنكليزية: 1,067 سؤالًا (علمي وأدبي)
> - الفلسفة: 1,689 سؤالًا (أدبي)
> - التاريخ: 4,048 سؤالًا (أدبي)
>
> أُزيلت مادة `demo` التجريبية بعد التحقق. الجغرافيا (2,788 سؤالًا) ما زالت في
> التطبيق السابق ولم تُستورد لأن ملفها المحلي غير متوفر وحدّ قراءة مشروعها القديم
> وصل إلى الحد اليومي.

## لوحة المدير

- الرابط: <https://bakaloria.github.io/bakaloriastages/#/admin>
- أول دخول: اسم المستخدم `admin` وكلمة المرور `admin123`.
- الحساب مرتبط بالبريد الداخلي `admin@students.bakaloriarace.app` والدور `admin`.
- عند أول دخول تُفتح **أمان الحساب** وحدها، ويُمنع استخدام بقية اللوحة حتى تغيير
  اسم المستخدم وكلمة المرور. لا تشارك البيانات الافتراضية مع أي طالب.
- Firebase يفرض 6 أحرف على الأقل لكلمة المرور؛ لذلك الافتراضية `admin123` وليست `admin`.

تتيح اللوحة:

- إغلاق بدء المراحل لكل الطلاب (`settings/global.stagesLocked`) مع رسالة مخصصة.
- إغلاق مرحلة مادة محددة أو إغلاق مادة كاملة (`subject_settings/{subjectId}.stagesLocked`).
- إيقاف التسجيل مؤقتًا، ونشر إعلانات في الرئيسية ومركز الإشعارات.
- ضبط `newPerStage` و`reviewPerStage` لكل مرحلة، وخطة الطالب الذي لم يتجاوز المرحلة
  (`failedNewPerStage` و`failedReviewPerStage`) وحد النجاح `passThreshold`.
- التحكم في طول الجلسة (`sessionStages`)، فواصل المراجعة (`intervalMinutes`)،
  عودة السؤال الخاطئ (`wrongIntervalMinutes`)، ونسبة الإتقان.
- منح دور مشرف لطالب أو سحبه، والاطلاع على آخر إجراءات الإدارة في `admin_audit`.

## البنية

```text
app/                 واجهة React + Vite + TypeScript (PWA)
app/src/lib/spark.ts تشغيل Spark المجاني: تصحيح وتقدم داخل المتصفح
app/src/pages/AdminPage.tsx      لوحة المدير والإعدادات والإعلانات
app/src/pages/NotificationsPage.tsx  مركز إشعارات الطالب
functions/           Firebase Cloud Functions (اختياري، يتطلب Blaze)
firestore.rules      قواعد وضع Spark (الافتراضي، مجاني)
firestore.functions.rules  قواعد وضع Functions المحصّن
firestore.indexes.json
firebase.json
functions/scripts/set-admin.mjs
functions/scripts/import-bank.mjs
tools/               محاكاة التغطية والمراحل
```

## التشغيل المحلي

```bash
cd app
npm install
npm run dev
```

لبناء نسخة الإنتاج إلى مجلد `docs/`:

```bash
cd app
npm run build
```

ثم شغّل معاينة:

```bash
npm run preview
```

## إعداد Firebase

1. أنشئ مشروع Firebase باسم `bakaloriarace` أو عدّل `.firebaserc`.
2. فعّل **Authentication → Email/Password**.
3. أنشئ **Firestore** (الخطة المجانية Spark تكفي):
   <https://console.firebase.google.com/project/bakaloriarace/firestore>
4. انسخ `firebaseConfig` من إعدادات المشروع إلى:
   - `app/public/firebase-config.js` (دائم، ويُنسخ مع البناء)، أو
   - شاشة الإعداد داخل التطبيق (تحفظ في المتصفح فقط).
   - أبقِ `backendMode: "spark"` للخطة المجانية.
5. انشر قواعد Firestore والفهارس فقط (لا يحتاج Functions):

```bash
npx firebase-tools login
npx firebase-tools use bakaloriarace
npx firebase-tools deploy --only firestore:rules,firestore:indexes
```

6. (اختياري) فعّل App Check: أضف `appCheckSiteKey` في `firebase-config.js`، ثم
   فعّل Enforcement على Firestore من Firebase Console. لا يوجد خادم لتطبيقه هنا.

### الترقية إلى وضع Functions (اختياري)

عند الحاجة إلى تصحيح خادمي محصّن:

```bash
cp firestore.functions.rules firestore.rules
npm --prefix functions install
npm --prefix functions run build
npx firebase-tools deploy --only firestore:rules,firestore:indexes,functions
```

ثم بدّل `backendMode` إلى `"functions"` في `firebase-config.js` وأعد بناء `docs/`.
هذا الوضع يتطلب خطة **Blaze**، لكن الاستهلاك غالبًا يبقى ضمن الحصة المجانية.

7. (اختياري في وضع Functions) أنشئ أول حساب طالب من التطبيق، ثم امنحه صلاحية مشرف:

```bash
npm --prefix functions install   # مرة واحدة، لتثبيت firebase-admin
GCLOUD_PROJECT=bakaloriarace node functions/scripts/set-admin.mjs <UID>
```

## استيراد المواد والأسئلة

تحتاج المجموعات التالية في Firestore:

- `subjects/{subjectId}`: `name`, `branches`, `active`, `sort`, `totalQuestions`, `icon`, `color`.
- `units/{unitId}`: `subjectId`, `title`, `sort`.
- `lessons/{lessonId}`: `subjectId`, `unitId`, `title`, `sort`.
- `questions/{questionId}`: بيانات السؤال (`subjectId`, `unitId`, `lessonId`, `type`, `text`, `options`, `orderIndex`, `active`). في وضع Spark تُضاف إليها `grading`, `correct`, `modelAnswer`, `explanation` لتصحيح من دون قراءة مستند إجابة منفصل، ما يبقي استيراد البنك كاملًا ضمن حصة الكتابة المجانية.
- `question_answers/{questionId}`: الإجابة الصحيحة والنموذجية والشرح والتقييم. في وضع Functions تبقى مغلقة تمامًا. في وضع Spark تُستخدم كخيار احتياطي للأسئلة القديمة/التجريبية فقط؛ الأسئلة المستوردة حديثًا تحمل الإجابة داخل مستند السؤال.
- `unit_totals/{subjectId}_{unitId}`: `total`, `title` (اختياري لكن يسرّع العرض).

تفاصيل الحقول موجودة في `FIREBASE-SETUP-ar.md`.

### استيراد آلي من JSON

الملف `functions/scripts/import-bank.mjs` يستورد المواد والوحدات والدروس والأسئلة
والإجابات السرية دفعة واحدة، ويحسب `totalQuestions` و`unit_totals` تلقائيًا:

```bash
npm --prefix functions install
# مطلوب Application Default Credentials أو service account مصرّح له
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
GCLOUD_PROJECT=bakaloriarace node functions/scripts/import-bank.mjs bank.json --dry-run
GCLOUD_PROJECT=bakaloriarace node functions/scripts/import-bank.mjs bank.json
```

صيغة مختصرة:

```json
{
  "subjects": [{ "id": "history", "name": "التاريخ", "branches": ["literary"], "sort": 1 }],
  "units": [{ "id": "history-u1", "subjectId": "history", "title": "الوحدة الأولى", "sort": 1 }],
  "lessons": [{ "id": "history-u1-l1", "subjectId": "history", "unitId": "history-u1", "title": "الدرس الأول", "sort": 1 }],
  "questions": [{
    "id": "history-0001", "subjectId": "history", "unitId": "history-u1",
    "lessonId": "history-u1-l1", "type": "mcq", "text": "نص السؤال",
    "options": ["أ", "ب", "ج", "د"], "orderIndex": 1, "grading": "auto",
    "correct": { "index": 0 }, "modelAnswer": { "index": 0 },
    "explanation": "شرح مختصر"
  }]
}
```

- `orderIndex` يجب أن يكون فريدًا وتصاعديًا داخل كل مادة.
- الأسئلة ذاتية التقييم تستخدم `"grading": "self"` مع `modelAnswer.text`.
- الأسئلة الآلية تدعم `mcq` و`true_false` و`fill_blank` و`matching` و`ordering`.
- الاستيراد يستخدم `merge` ولا يحذف ما ليس في الملف.
- استخدم الملف الكامل للمادة في كل مرة، لأن `totalQuestions` يُحسب من الملف
  المعطى وليس من مجموع الأسئلة الموجود مسبقًا في Firestore.

## النشر على GitHub Pages

الواجهة مبنية بـ `base: "/bakaloriastages/"` وتُخرج إلى `docs/`:

```bash
cd app
npm run build
cd ..
git add docs
git commit -m "build: publish PWA"
git push origin main
```

في GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: main / docs**:
<https://github.com/bakaloria/bakaloriastages/settings/pages>

بعد ظهور رابط GitHub Pages، أضف `bakaloria.github.io` إلى
**Firebase Console → Authentication → Settings → Authorized domains**.

> تم تفعيل GitHub Pages وإضافة النطاق بالفعل. تبقى الخطوات أعلاه مرجعًا لإعادة
> النشر من نسخة جديدة.

> ملاحظة: لا تضع GitHub Token أو Service Account أو Private Key في المستودع. إعدادات Firebase Web عامة بطبيعتها، لكنها ليست بديلًا عن قواعد الأمان.

## حالة التنفيذ

- [x] Backend Firebase: تسجيل، انضمام، مراحل، تصحيح، تقييم ذاتي، تقدم، ترتيب، شهادة.
- [x] وضع Spark المجاني: كل العمليات من الواجهة عبر Auth + Firestore، بلا Functions.
- [x] وضع Functions محفوظ للترقية إلى Blaze مع قواعد محصّنة.
- [x] واجهة PWA عربية: دخول/تسجيل، مواد، مرحلة، نتائج، تقييم ذاتي، تقدم، ترتيب، حساب، شهادة.
- [x] بناء إنتاجي إلى `docs/` مع مسار GitHub Pages وHashRouter.
- [x] PWA: manifest وأيقونات وService Worker.
- [x] وضع `firebaseConfig` الحقيقي في `app/public/firebase-config.js`.
- [x] رفع الكود ونسخة `docs/` إلى `bakaloria/bakaloriastages`.
- [x] تفعيل GitHub Pages (Source: main / docs) والرابط المباشر يعمل.
- [x] إنشاء Firestore في مشروع `bakaloriarace` (Authentication مفعّل بالفعل).
- [x] نشر قواعد Firestore والفهارس.
- [x] اختبار قواعد الأمان والاستعلامات والفهارس على البنك الحقيقي (32/32).
- [x] إضافة `bakaloria.github.io` إلى Authorized domains.
- [x] استيراد بنك الأسئلة الفعلي (6 مواد، 11,901 سؤالًا) إلى Firestore مع إجابات مدمجة.
- [x] إزالة المادة التجريبية `demo` بعد التحقق من البنك الحقيقي.
- [x] لوحة مدير: إغلاق المراحل، الإعلانات، إدارة الطلاب، وبيانات الدخول الإلزامية.
- [x] إعدادات عامة ولكل مادة، وخطة تعافٍ للطالب الذي لم يتجاوز المرحلة.
- [x] مركز إشعارات للطالب وتنبيه غير مقروء في شريط التنقل.
- [x] إصلاح `resource == null` في قواعد Firestore، وهو سبب خطأ «تعذر بدء المرحلة».
- [x] اختبار دورة المرحلة كاملة عبر Firebase SDK الحقيقي: بدء، تسليم، نموذج إجابة،
      تقييم ذاتي، مراجعة، انتقال للمرحلة التالية.
- [ ] اختبار بصري/يدوي كامل من واجهة المتصفح على أجهزة مختلفة.
- [ ] الترقية الاختيارية إلى Blaze ووضع Functions.
- [ ] الامتحان النهائي الاختياري.

> ملاحظة: شاشة الإعداد المحلية ما زالت موجودة كحل مؤقت للمعاينة، لكنها تحفظ
> الإعدادات في المتصفح فقط. الإعدادات المنشورة موجودة الآن في
> `app/public/firebase-config.js`.

## الأمان

### وضع Spark (الافتراضي المجاني)

- التصحيح يتم في المتصفح، لذلك الإجابات مدمجة في `questions` (`grading`, `correct`,
  `modelAnswer`) أو في `question_answers` للأسئلة القديمة، وكلها متاحة للطلاب
  المسجلين.
- `enrollments` مقروءة للمسجلين لأن الترتيب يُبنى منها؛ الكتابة مقصورة على صاحب السجل.
- `progress` و`stage_attempts` و`unit_progress` و`certificates` خاصة بصاحبها.
- `settings/global` و`subject_settings` و`announcements` و`admin_audit` يكتبها المدير فقط.
- قواعدها تسمح بـ `get` عندما يكون المستند غير موجود (`resource == null`)؛ بدونها
  يفشل أول استدعاء داخل `startStage` برسالة «تعذر بدء المرحلة» قبل إنشاء أي سجل.
- يمكن لطالب متمكن تعديل درجاته أو ترتيبه عبر SDK. هذا مقبول لتطبيق تعليمي، وليس لاختبار رسمي.

### وضع Functions (بعد Blaze)

- الطالب لا يقرأ `question_answers` ولا يكتب التقدم مباشرة.
- كل الدوال تتحقق من المصادقة وApp Check.
- الإجابات الصحيحة لا تصل إلى الواجهة قبل التسليم.
- الأسئلة المقالية والقصيرة تُقيّم ذاتيًا بعد إظهار النموذج، ويُسجّل التقييم في المحاولة.
- الترتيب العام يعتمد على الأسئلة المصححة آليًا فقط.

## الترخيص

خاص بمشروع مراحل البكالوريا. راجع مالك المستودع قبل إعادة الاستخدام.
