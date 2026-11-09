# مراحل البكالوريا — Bakaloriastages

تطبيق ويب تقدمي (PWA) عربي لطلاب البكالوريا، يقوم على مسابقة دراسية تراكمية:

- حساب طالب باسم مستخدم وكلمة مرور.
- اختيار الفرع (علمي / أدبي) والمواد المناسبة.
- كل مادة مسابقة مستقلة: أسئلة جديدة + مراجعة متباعدة.
- إجابة نموذجية بعد كل مرحلة، ولا يمكن بدء المرحلة التالية قبل الاطلاع عليها.
- تغطية كل أسئلة المادة، ثم الإتقان، ثم شهادة إتمام.
- تقدم محفوظ في Firebase (Auth + Firestore + Cloud Functions).
- تصحيح الأسئلة الآلية داخل الخادم، والأسئلة المقالية بتقييم ذاتي موثّق.

## الرابط

- GitHub: <https://github.com/bakaloria/bakaloriastages>
- التطبيق بعد النشر: <https://bakaloria.github.io/bakaloriastages/>

## البنية

```text
app/                 واجهة React + Vite + TypeScript (PWA)
functions/           Firebase Cloud Functions (TypeScript)
firestore.rules      قواعد قراءة/كتابة Firestore
firestore.indexes.json
firebase.json
scripts/set-admin.mjs
supabase/            مخطط بديل غير مفعّل
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
3. أنشئ **Firestore**.
4. رقّ إلى خطة **Blaze** لأن Cloud Functions تحتاجها.
5. انسخ `firebaseConfig` من إعدادات المشروع إلى:
   - `app/public/firebase-config.js` (دائم، ويُنسخ مع البناء)، أو
   - شاشة الإعداد داخل التطبيق (تحفظ في المتصفح فقط).
6. انشر القواعد والدوال:

```bash
npm --prefix functions install
npm --prefix functions run build
npx firebase-tools login
npx firebase-tools use bakaloriarace
npx firebase-tools deploy --only firestore:rules,firestore:indexes,functions
```

7. (اختياري) فعّل App Check: أضف `appCheckSiteKey` في `firebase-config.js`، وبعد
   تسجيل reCAPTCHA v3 أعد نشر الدوال مع `ENFORCE_APP_CHECK=true`.

8. أنشئ أول حساب طالب من التطبيق، ثم امنحه صلاحية مشرف:

```bash
GCLOUD_PROJECT=bakaloriarace node scripts/set-admin.mjs <username>
```

## استيراد المواد والأسئلة

تحتاج المجموعات التالية في Firestore:

- `subjects/{subjectId}`: `name`, `branches`, `active`, `sort`, `totalQuestions`, `icon`, `color`.
- `units/{unitId}`: `subjectId`, `title`, `sort`.
- `lessons/{lessonId}`: `subjectId`, `unitId`, `title`, `sort`.
- `questions/{questionId}`: بيانات السؤال العامة (`subjectId`, `unitId`, `lessonId`, `type`, `text`, `options`, `orderIndex`, `active`).
- `question_answers/{questionId}`: الإجابة الصحيحة والنموذجية والشرح والتقييم. هذه المجموعة لا تُقرأ من العميل.
- `unit_totals/{subjectId}_{unitId}`: `total`, `title` (اختياري لكن يسرّع العرض).

تفاصيل الحقول موجودة في `FIREBASE-SETUP-ar.md`.

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

في GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: main / docs**.

> ملاحظة: لا تضع GitHub Token أو Service Account أو Private Key في المستودع. إعدادات Firebase Web عامة بطبيعتها، لكنها ليست بديلًا عن قواعد الأمان.

## حالة التنفيذ

- [x] Backend Firebase: تسجيل، انضمام، مراحل، تصحيح، تقييم ذاتي، تقدم، ترتيب، شهادة.
- [x] واجهة PWA عربية: دخول/تسجيل، مواد، مرحلة، نتائج، تقييم ذاتي، تقدم، ترتيب، حساب، شهادة.
- [x] بناء إنتاجي إلى `docs/` مع مسار GitHub Pages وHashRouter.
- [x] PWA: manifest وأيقونات وService Worker.
- [ ] وضع `firebaseConfig` الحقيقي في `app/public/firebase-config.js` (التطبيق يعرض شاشة الإعداد حتى ذلك الحين).
- [ ] استيراد بنك الأسئلة الفعلي إلى Firestore.
- [ ] نشر قواعد Firestore والدوال على مشروع `bakaloriarace`.
- [ ] تفعيل App Check بعد تسجيل reCAPTCHA v3.
- [ ] الامتحان النهائي ولوحة تحكم المشرف.

> ملاحظة: إذا لم تكن `apiKey` و`appId` مضبوطتين، يعرض التطبيق شاشة إعداد تسمح بلصق
> `firebaseConfig` محليًا للمعاينة. الإعداد المحلي لا يكفي لجميع الطلاب؛ يجب وضع
> الإعدادات في `app/public/firebase-config.js` وإعادة البناء والنشر.

## الأمان

- الطالب لا يقرأ `question_answers` ولا يكتب التقدم مباشرة.
- كل الدوال تتحقق من المصادقة وApp Check.
- الإجابات الصحيحة لا تصل إلى الواجهة قبل التسليم.
- الأسئلة المقالية والقصيرة تُقيّم ذاتيًا بعد إظهار النموذج، ويُسجّل التقييم في المحاولة.
- الترتيب العام يعتمد على الأسئلة المصححة آليًا فقط.

## الترخيص

خاص بمشروع مراحل البكالوريا. راجع مالك المستودع قبل إعادة الاستخدام.
