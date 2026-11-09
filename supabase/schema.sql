-- ============================================================
-- مراحل البكالوريا — Supabase schema
-- شغّل هذا الملف مرة واحدة في مشروع Supabase جديد.
-- لا يحتوي على أي مفاتيح أو أسرار.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- الأنواع ----------
do $$ begin create type public.branch as enum ('scientific','literary'); exception when duplicate_object then null; end $$;
do $$ begin create type public.question_type as enum ('mcq','true_false','fill_blank','matching','ordering','comparison','short_answer','essay'); exception when duplicate_object then null; end $$;
do $$ begin create type public.grading_mode as enum ('auto','self','manual'); exception when duplicate_object then null; end $$;
do $$ begin create type public.enrollment_status as enum ('active','completed','paused'); exception when duplicate_object then null; end $$;
do $$ begin create type public.self_score as enum ('correct','partial','wrong'); exception when duplicate_object then null; end $$;

-- ---------- الملفات الشخصية ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  display_name text not null,
  branch public.branch,
  role text not null default 'student' check (role in ('student','admin')),
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username));

-- ---------- المحتوى ----------
create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  branches public.branch[] not null default '{}',
  icon text,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.units (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects(id) on delete cascade,
  title text not null,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists units_subject_idx on public.units(subject_id, sort);

create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  title text not null,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists lessons_unit_idx on public.lessons(unit_id, sort);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  type public.question_type not null,
  text text not null,
  options jsonb,
  correct jsonb,
  model_answer jsonb not null,
  explanation text,
  grading public.grading_mode not null default 'auto',
  difficulty int not null default 1,
  points int not null default 1,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint questions_correct_required check (grading = 'self' or correct is not null)
);
create index if not exists questions_lesson_idx on public.questions(lesson_id, sort) where active;

-- ---------- الإعدادات ----------
create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now()
);

create table if not exists public.subject_settings (
  subject_id uuid primary key references public.subjects(id) on delete cascade,
  stage_size int not null default 5 check (stage_size between 5 and 20),
  new_per_stage int not null default 3 check (new_per_stage >= 1),
  review_per_stage int not null default 2 check (review_per_stage >= 0),
  session_stages int not null default 10 check (session_stages between 3 and 15),
  interval_minutes int not null default 120 check (interval_minutes between 15 and 1440),
  mastery_threshold numeric(5,4) not null default 1.0000 check (mastery_threshold between 0 and 1),
  final_exam_required boolean not null default false,
  final_exam_questions int not null default 40 check (final_exam_questions between 20 and 60),
  final_exam_pass numeric(5,4) not null default 0.8000 check (final_exam_pass between 0 and 1),
  require_all_questions boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint subject_settings_stage_sum check (new_per_stage + review_per_stage <= stage_size)
);

-- ---------- التسجيل والتقدم ----------
create table if not exists public.enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  status public.enrollment_status not null default 'active',
  current_lesson_id uuid references public.lessons(id),
  points int not null default 0,
  streak int not null default 0,
  total_questions int not null default 0,
  coverage_count int not null default 0,
  mastery_count int not null default 0,
  stages_in_session int not null default 0,
  session_no int not null default 1,
  next_available_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  mastery_completed_at timestamptz,
  unique (user_id, subject_id)
);
create index if not exists enrollments_user_idx on public.enrollments(user_id);

create table if not exists public.stage_attempts (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  stage_no int not null,
  session_no int not null,
  stage_in_session int not null,
  status text not null default 'in_progress' check (status in ('in_progress','submitted','expired')),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  score numeric(6,2),
  unique (enrollment_id, stage_no)
);
create index if not exists stage_attempts_enrollment_idx on public.stage_attempts(enrollment_id, stage_no);

create table if not exists public.stage_items (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.stage_attempts(id) on delete cascade,
  question_id uuid not null references public.questions(id),
  position int not null,
  is_review boolean not null default false,
  unique (attempt_id, question_id),
  unique (attempt_id, position)
);
create index if not exists stage_items_attempt_idx on public.stage_items(attempt_id, position);

create table if not exists public.attempt_answers (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.stage_attempts(id) on delete cascade,
  question_id uuid not null references public.questions(id),
  answer jsonb,
  is_correct boolean,
  self_score public.self_score,
  time_ms int not null default 0,
  feedback_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (attempt_id, question_id)
);
create index if not exists attempt_answers_attempt_idx on public.attempt_answers(attempt_id);

create table if not exists public.question_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  seen_count int not null default 0,
  correct_count int not null default 0,
  wrong_count int not null default 0,
  first_attempt_correct boolean,
  mastery_level int not null default 0 check (mastery_level between 0 and 3),
  last_seen_at timestamptz,
  next_review_at timestamptz,
  unique (user_id, question_id)
);
create index if not exists question_progress_review_idx on public.question_progress(enrollment_id, next_review_at);
create index if not exists question_progress_mastery_idx on public.question_progress(enrollment_id, mastery_level);

create table if not exists public.final_exam_attempts (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  score numeric(5,2),
  passed boolean not null default false,
  answers jsonb
);
create index if not exists final_exam_enrollment_idx on public.final_exam_attempts(enrollment_id);

create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  coverage_count int not null,
  mastery_count int not null,
  final_score numeric(5,2),
  code text unique not null,
  issued_at timestamptz not null default now(),
  unique (user_id, subject_id)
);
create index if not exists certificates_user_idx on public.certificates(user_id);

-- ---------- دوال مساعدة ----------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.owns_enrollment(p_enrollment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.enrollments
    where id = p_enrollment_id and user_id = auth.uid()
  );
$$;

create or replace function public.owns_attempt(p_attempt_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.stage_attempts a
    join public.enrollments e on e.id = a.enrollment_id
    where a.id = p_attempt_id and e.user_id = auth.uid()
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name, branch)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    nullif(new.raw_user_meta_data->>'branch', '')::public.branch
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.subjects enable row level security;
alter table public.units enable row level security;
alter table public.lessons enable row level security;
alter table public.questions enable row level security;
alter table public.settings enable row level security;
alter table public.subject_settings enable row level security;
alter table public.enrollments enable row level security;
alter table public.stage_attempts enable row level security;
alter table public.stage_items enable row level security;
alter table public.attempt_answers enable row level security;
alter table public.question_progress enable row level security;
alter table public.final_exam_attempts enable row level security;
alter table public.certificates enable row level security;

-- profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
for select to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- subjects
drop policy if exists subjects_read on public.subjects;
create policy subjects_read on public.subjects
for select to authenticated
using (active or public.is_admin());

drop policy if exists subjects_admin_all on public.subjects;
create policy subjects_admin_all on public.subjects
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- units
drop policy if exists units_read on public.units;
create policy units_read on public.units
for select to authenticated using (true);

drop policy if exists units_admin_all on public.units;
create policy units_admin_all on public.units
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- lessons
drop policy if exists lessons_read on public.lessons;
create policy lessons_read on public.lessons
for select to authenticated using (true);

drop policy if exists lessons_admin_all on public.lessons;
create policy lessons_admin_all on public.lessons
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- questions: لا يقرأها الطالب مباشرة؛ القراءة عبر RPC فقط
drop policy if exists questions_admin_all on public.questions;
create policy questions_admin_all on public.questions
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- settings
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings
for select to authenticated using (true);

drop policy if exists settings_admin_all on public.settings;
create policy settings_admin_all on public.settings
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists subject_settings_read on public.subject_settings;
create policy subject_settings_read on public.subject_settings
for select to authenticated using (true);

drop policy if exists subject_settings_admin_all on public.subject_settings;
create policy subject_settings_admin_all on public.subject_settings
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- enrollments
drop policy if exists enrollments_select on public.enrollments;
create policy enrollments_select on public.enrollments
for select to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists enrollments_admin_all on public.enrollments;
create policy enrollments_admin_all on public.enrollments
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- stage_attempts
drop policy if exists stage_attempts_select on public.stage_attempts;
create policy stage_attempts_select on public.stage_attempts
for select to authenticated
using (public.owns_enrollment(enrollment_id) or public.is_admin());

drop policy if exists stage_attempts_admin_all on public.stage_attempts;
create policy stage_attempts_admin_all on public.stage_attempts
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- stage_items
drop policy if exists stage_items_select on public.stage_items;
create policy stage_items_select on public.stage_items
for select to authenticated
using (public.owns_attempt(attempt_id) or public.is_admin());

drop policy if exists stage_items_admin_all on public.stage_items;
create policy stage_items_admin_all on public.stage_items
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- attempt_answers
drop policy if exists attempt_answers_select on public.attempt_answers;
create policy attempt_answers_select on public.attempt_answers
for select to authenticated
using (public.owns_attempt(attempt_id) or public.is_admin());

drop policy if exists attempt_answers_admin_all on public.attempt_answers;
create policy attempt_answers_admin_all on public.attempt_answers
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- question_progress
drop policy if exists question_progress_select on public.question_progress;
create policy question_progress_select on public.question_progress
for select to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists question_progress_admin_all on public.question_progress;
create policy question_progress_admin_all on public.question_progress
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- final_exam_attempts
drop policy if exists final_exam_select on public.final_exam_attempts;
create policy final_exam_select on public.final_exam_attempts
for select to authenticated
using (public.owns_enrollment(enrollment_id) or public.is_admin());

drop policy if exists final_exam_admin_all on public.final_exam_attempts;
create policy final_exam_admin_all on public.final_exam_attempts
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- certificates
drop policy if exists certificates_select on public.certificates;
create policy certificates_select on public.certificates
for select to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists certificates_admin_all on public.certificates;
create policy certificates_admin_all on public.certificates
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- ---------- الصلاحيات ----------
revoke all on all tables in schema public from anon, authenticated;

grant select on public.subjects, public.units, public.lessons, public.settings, public.subject_settings to authenticated;
grant select on public.profiles, public.enrollments, public.stage_attempts, public.stage_items,
  public.attempt_answers, public.question_progress, public.final_exam_attempts, public.certificates
  to authenticated;
grant select on public.questions to authenticated;
grant update (display_name, branch) on public.profiles to authenticated;

grant insert, update, delete on public.subjects, public.units, public.lessons,
  public.questions, public.settings, public.subject_settings to authenticated;

-- ---------- RPC: الانضمام ----------
create or replace function public.join_subject(p_subject_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_total int;
  v_lesson uuid;
  v_enrollment public.enrollments;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not exists (select 1 from public.subjects where id = p_subject_id and active) then
    raise exception 'SUBJECT_NOT_FOUND';
  end if;

  select count(*) into v_total
  from public.questions q
  join public.lessons l on l.id = q.lesson_id
  join public.units u on u.id = l.unit_id
  where u.subject_id = p_subject_id and q.active;

  select l.id into v_lesson
  from public.lessons l
  join public.units u on u.id = l.unit_id
  where u.subject_id = p_subject_id
  order by u.sort, l.sort
  limit 1;

  insert into public.enrollments (user_id, subject_id, total_questions, current_lesson_id)
  values (v_uid, p_subject_id, v_total, v_lesson)
  on conflict (user_id, subject_id) do nothing;

  insert into public.subject_settings (subject_id)
  values (p_subject_id)
  on conflict (subject_id) do nothing;

  select * into v_enrollment
  from public.enrollments
  where user_id = v_uid and subject_id = p_subject_id;

  return jsonb_build_object(
    'enrollment_id', v_enrollment.id,
    'total_questions', v_enrollment.total_questions,
    'coverage_count', v_enrollment.coverage_count,
    'mastery_count', v_enrollment.mastery_count,
    'next_available_at', v_enrollment.next_available_at
  );
end;
$$;

-- ---------- RPC: بدء مرحلة ----------
create or replace function public.stage_payload(p_attempt_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'attempt_id', a.id,
    'stage_no', a.stage_no,
    'session_no', a.session_no,
    'stage_in_session', a.stage_in_session,
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'question_id', q.id,
        'type', q.type,
        'text', q.text,
        'options', q.options,
        'is_review', si.is_review,
        'position', si.position
      ) order by si.position)
      from public.stage_items si
      join public.questions q on q.id = si.question_id
      where si.attempt_id = a.id
    ), '[]'::jsonb)
  )
  from public.stage_attempts a
  where a.id = p_attempt_id;
$$;

create or replace function public.start_stage(p_subject_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_enrollment public.enrollments;
  v_settings public.subject_settings;
  v_existing public.stage_attempts;
  v_attempt public.stage_attempts;
  v_stage_no int;
  v_new_count int;
  v_review_count int;
  v_stage_size int;
  v_count int;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;

  select * into v_enrollment
  from public.enrollments
  where user_id = v_uid and subject_id = p_subject_id;

  if not found then
    perform public.join_subject(p_subject_id);
    select * into v_enrollment
    from public.enrollments
    where user_id = v_uid and subject_id = p_subject_id;
  end if;

  select * into v_settings
  from public.subject_settings
  where subject_id = p_subject_id;

  if not found then
    insert into public.subject_settings (subject_id)
    values (p_subject_id)
    on conflict (subject_id) do nothing;
    select * into v_settings
    from public.subject_settings
    where subject_id = p_subject_id;
  end if;

  if v_enrollment.next_available_at is not null
     and v_enrollment.next_available_at > now() then
    return jsonb_build_object(
      'locked', true,
      'next_available_at', v_enrollment.next_available_at,
      'session_no', v_enrollment.session_no,
      'stages_in_session', v_enrollment.stages_in_session
    );
  end if;

  select * into v_existing
  from public.stage_attempts
  where enrollment_id = v_enrollment.id and status = 'in_progress'
  order by started_at desc
  limit 1;

  if found then
    return public.stage_payload(v_existing.id) || jsonb_build_object('resumed', true);
  end if;

  if v_enrollment.total_questions > 0
     and v_enrollment.coverage_count >= v_enrollment.total_questions
     and v_enrollment.mastery_count >= ceil(v_enrollment.total_questions * v_settings.mastery_threshold)::int then
    raise exception 'SUBJECT_COMPLETE';
  end if;

  select coalesce(max(stage_no), 0) + 1 into v_stage_no
  from public.stage_attempts
  where enrollment_id = v_enrollment.id;

  if v_stage_no <= 4 then
    v_new_count := 1;
    v_review_count := v_stage_no - 1;
  else
    v_new_count := v_settings.new_per_stage;
    v_review_count := v_settings.review_per_stage;
  end if;
  v_stage_size := v_new_count + v_review_count;

  insert into public.stage_attempts (enrollment_id, stage_no, session_no, stage_in_session)
  values (v_enrollment.id, v_stage_no, v_enrollment.session_no, v_enrollment.stages_in_session + 1)
  returning * into v_attempt;

  -- 1) أسئلة جديدة
  with picked as (
    select q.id, u.sort as unit_sort, l.sort as lesson_sort, q.sort as question_sort
    from public.questions q
    join public.lessons l on l.id = q.lesson_id
    join public.units u on u.id = l.unit_id
    where u.subject_id = p_subject_id
      and q.active
      and not exists (
        select 1 from public.question_progress qp
        where qp.user_id = v_uid and qp.question_id = q.id
      )
    order by u.sort, l.sort, q.sort, q.id
    limit v_new_count
  )
  insert into public.stage_items (attempt_id, question_id, position, is_review)
  select v_attempt.id, picked.id,
         (row_number() over (order by picked.unit_sort, picked.lesson_sort, picked.question_sort, picked.id))::int,
         false
  from picked;

  -- 2) أسئلة المراجعة المستحقة
  with picked as (
    select q.id,
           row_number() over (
             order by qp.wrong_count desc, qp.next_review_at asc nulls first, q.id
           )::int as rn
    from public.question_progress qp
    join public.questions q on q.id = qp.question_id
    join public.lessons l on l.id = q.lesson_id
    join public.units u on u.id = l.unit_id
    where qp.user_id = v_uid
      and qp.enrollment_id = v_enrollment.id
      and q.active
      and (qp.next_review_at is null or qp.next_review_at <= now())
      and not exists (
        select 1 from public.stage_items si
        where si.attempt_id = v_attempt.id and si.question_id = q.id
      )
    order by qp.wrong_count desc, qp.next_review_at asc nulls first, q.id
    limit v_review_count
  ),
  base as (
    select coalesce(max(position), 0) as max_pos
    from public.stage_items where attempt_id = v_attempt.id
  )
  insert into public.stage_items (attempt_id, question_id, position, is_review)
  select v_attempt.id, picked.id, (base.max_pos + picked.rn)::int, true
  from picked cross join base;

  -- 3) ملء العدد المتبقي من أي سؤال نشط غير مكرر
  with base as (
    select coalesce(max(position), 0) as max_pos, count(*) as cnt
    from public.stage_items where attempt_id = v_attempt.id
  ),
  need as (
    select greatest(v_stage_size - base.cnt, 0) as n from base
  ),
  picked as (
    select q.id,
           (row_number() over (order by u.sort, l.sort, q.sort, q.id))::int as rn,
           exists (
             select 1 from public.question_progress qp
             where qp.user_id = v_uid and qp.question_id = q.id
           ) as is_rev
    from public.questions q
    join public.lessons l on l.id = q.lesson_id
    join public.units u on u.id = l.unit_id
    cross join need
    where u.subject_id = p_subject_id
      and q.active
      and not exists (
        select 1 from public.stage_items si
        where si.attempt_id = v_attempt.id and si.question_id = q.id
      )
    order by u.sort, l.sort, q.sort, q.id
    limit (select n from need)
  )
  insert into public.stage_items (attempt_id, question_id, position, is_review)
  select v_attempt.id, picked.id, (base.max_pos + picked.rn)::int, picked.is_rev
  from picked cross join base;

  select count(*) into v_count from public.stage_items where attempt_id = v_attempt.id;
  if v_count = 0 then
    delete from public.stage_attempts where id = v_attempt.id;
    raise exception 'NO_QUESTIONS_AVAILABLE';
  end if;

  return public.stage_payload(v_attempt.id) || jsonb_build_object(
    'session_stages', v_settings.session_stages,
    'session_no', v_enrollment.session_no
  );
end;
$$;

-- ---------- RPC: تسليم المرحلة ----------
create or replace function public.submit_stage(p_attempt_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_attempt public.stage_attempts;
  v_enrollment public.enrollments;
  v_settings public.subject_settings;
  v_item public.stage_items;
  v_question public.questions;
  v_answer jsonb;
  v_self public.self_score;
  v_is_correct boolean;
  v_time_ms int;
  v_cov bigint;
  v_mast bigint;
  v_session_complete boolean := false;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    raise exception 'INVALID_ANSWERS';
  end if;

  select * into v_attempt
  from public.stage_attempts
  where id = p_attempt_id and status = 'in_progress';
  if not found then raise exception 'ATTEMPT_NOT_FOUND'; end if;

  select * into v_enrollment
  from public.enrollments
  where id = v_attempt.enrollment_id and user_id = v_uid;
  if not found then raise exception 'ATTEMPT_NOT_FOUND'; end if;

  select * into v_settings
  from public.subject_settings
  where subject_id = v_enrollment.subject_id;

  if exists (select 1 from public.attempt_answers where attempt_id = p_attempt_id) then
    raise exception 'ALREADY_SUBMITTED';
  end if;

  for v_item in
    select * from public.stage_items
    where attempt_id = p_attempt_id
    order by position
  loop
    v_answer := null;
    select elem into v_answer
    from jsonb_array_elements(p_answers) elem
    where elem->>'question_id' = v_item.question_id::text
    limit 1;

    select * into v_question from public.questions where id = v_item.question_id;
    v_self := null;
    v_is_correct := null;
    v_time_ms := case
      when (v_answer->>'time_ms') ~ '^[0-9]+$' then (v_answer->>'time_ms')::int
      else 0
    end;

    if v_question.grading = 'auto' then
      if v_question.type = 'mcq' then
        v_is_correct := coalesce(
          (v_answer->>'index')::int = (v_question.correct->>'index')::int,
          false
        );
      elsif v_question.type = 'true_false' then
        v_is_correct := coalesce(
          (v_answer->>'value')::boolean = (v_question.correct->>'value')::boolean,
          false
        );
      elsif v_question.type = 'fill_blank' then
        v_is_correct := coalesce(
          lower(trim(v_answer->>'text')) = lower(trim(v_question.correct->>'text')),
          false
        );
      else
        v_is_correct := coalesce(v_answer = v_question.correct, false);
      end if;
    elsif v_question.grading = 'self' then
      if v_answer ? 'self_score' then
        v_self := (v_answer->>'self_score')::public.self_score;
      else
        v_self := 'wrong';
      end if;
      v_is_correct := (v_self = 'correct');
    end if;

    insert into public.attempt_answers
      (attempt_id, question_id, answer, is_correct, self_score, time_ms)
    values
      (p_attempt_id, v_item.question_id, v_answer, v_is_correct, v_self, v_time_ms);

    if v_is_correct is not null then
      insert into public.question_progress
        (user_id, enrollment_id, question_id, seen_count, correct_count, wrong_count,
         first_attempt_correct, mastery_level, last_seen_at, next_review_at)
      values
        (v_uid, v_enrollment.id, v_item.question_id,
         1,
         case when v_is_correct then 1 else 0 end,
         case when v_is_correct then 0 else 1 end,
         v_is_correct,
         case when v_is_correct then 1 else 0 end,
         now(),
         case when v_is_correct then now() + interval '1 day' else now() + interval '10 minutes' end)
      on conflict (user_id, question_id) do update set
        seen_count = public.question_progress.seen_count + 1,
        correct_count = public.question_progress.correct_count + case when v_is_correct then 1 else 0 end,
        wrong_count = public.question_progress.wrong_count + case when v_is_correct then 0 else 1 end,
        first_attempt_correct = coalesce(public.question_progress.first_attempt_correct, v_is_correct),
        mastery_level = case
          when v_is_correct and public.question_progress.mastery_level = 0 then 1
          when v_is_correct and public.question_progress.mastery_level = 1
               and (public.question_progress.next_review_at is null or public.question_progress.next_review_at <= now()) then 2
          when v_is_correct and public.question_progress.mastery_level = 2
               and (public.question_progress.next_review_at is null or public.question_progress.next_review_at <= now()) then 3
          else public.question_progress.mastery_level
        end,
        last_seen_at = now(),
        next_review_at = case
          when not v_is_correct then now() + interval '10 minutes'
          when public.question_progress.mastery_level >= 2 then now() + interval '7 days'
          when public.question_progress.mastery_level = 1 then now() + interval '3 days'
          else now() + interval '1 day'
        end;
    end if;
  end loop;

  select count(*), count(*) filter (where correct_count > 0)
  into v_cov, v_mast
  from public.question_progress
  where enrollment_id = v_enrollment.id;

  v_session_complete := v_attempt.stage_in_session >= v_settings.session_stages;

  update public.enrollments
  set coverage_count = v_cov,
      mastery_count = v_mast,
      stages_in_session = case when v_session_complete then 0 else v_attempt.stage_in_session end,
      session_no = case when v_session_complete then session_no + 1 else session_no end,
      next_available_at = case
        when v_session_complete then now() + make_interval(mins => v_settings.interval_minutes)
        else next_available_at
      end,
      completed_at = case
        when total_questions > 0
         and v_cov >= total_questions
         and v_mast >= ceil(total_questions * v_settings.mastery_threshold)::int
        then coalesce(completed_at, now())
        else completed_at
      end,
      mastery_completed_at = case
        when total_questions > 0 and v_mast >= total_questions
        then coalesce(mastery_completed_at, now())
        else mastery_completed_at
      end
  where id = v_enrollment.id;

  update public.stage_attempts
  set status = 'submitted', submitted_at = now()
  where id = p_attempt_id;

  return jsonb_build_object(
    'attempt_id', p_attempt_id,
    'results', coalesce((
      select jsonb_agg(jsonb_build_object(
        'question_id', aa.question_id,
        'answer', aa.answer,
        'is_correct', aa.is_correct,
        'self_score', aa.self_score,
        'model_answer', q.model_answer,
        'explanation', q.explanation,
        'position', si.position,
        'is_review', si.is_review
      ) order by si.position)
      from public.attempt_answers aa
      join public.stage_items si
        on si.attempt_id = aa.attempt_id and si.question_id = aa.question_id
      join public.questions q on q.id = aa.question_id
      where aa.attempt_id = p_attempt_id
    ), '[]'::jsonb),
    'session_complete', v_session_complete,
    'next_available_at', (select next_available_at from public.enrollments where id = v_enrollment.id),
    'coverage_count', v_cov,
    'mastery_count', v_mast,
    'total_questions', v_enrollment.total_questions,
    'mastery_target', ceil(v_enrollment.total_questions * v_settings.mastery_threshold)::int
  );
end;
$$;

-- ---------- RPC: التقدم ----------
create or replace function public.get_subject_progress(p_subject_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_enrollment public.enrollments;
  v_result jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;

  select * into v_enrollment
  from public.enrollments
  where user_id = v_uid and subject_id = p_subject_id;
  if not found then raise exception 'NOT_ENROLLED'; end if;

  with q as (
    select u.id as unit_id, u.title as unit_title,
           l.id as lesson_id, l.title as lesson_title,
           q.id as question_id
    from public.units u
    join public.lessons l on l.unit_id = u.id
    join public.questions q on q.lesson_id = l.id
    where u.subject_id = p_subject_id and q.active
  ),
  p as (
    select q.*,
           (qp.question_id is not null) as seen,
           coalesce(qp.correct_count, 0) > 0 as mastered
    from q
    left join public.question_progress qp
      on qp.question_id = q.question_id and qp.user_id = v_uid
  )
  select jsonb_build_object(
    'coverage_count', count(*) filter (where seen),
    'mastery_count', count(*) filter (where mastered),
    'total_questions', count(*),
    'by_unit', coalesce((
      select jsonb_agg(jsonb_build_object(
        'unit_id', unit_id,
        'title', unit_title,
        'total', total,
        'seen', seen,
        'mastered', mastered
      ) order by unit_title)
      from (
        select unit_id, unit_title,
               count(*) as total,
               count(*) filter (where seen) as seen,
               count(*) filter (where mastered) as mastered
        from p
        group by unit_id, unit_title
      ) x
    ), '[]'::jsonb)
  )
  into v_result
  from p;

  return v_result || jsonb_build_object(
    'next_available_at', v_enrollment.next_available_at,
    'session_no', v_enrollment.session_no,
    'stages_in_session', v_enrollment.stages_in_session,
    'completed_at', v_enrollment.completed_at,
    'mastery_completed_at', v_enrollment.mastery_completed_at
  );
end;
$$;

-- ---------- RPC: لوحة المتصدرين ----------
create or replace function public.get_leaderboard(p_subject_id uuid, p_limit int default 50)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with auto_q as (
    select q.id
    from public.questions q
    join public.lessons l on l.id = q.lesson_id
    join public.units u on u.id = l.unit_id
    where u.subject_id = p_subject_id and q.active and q.grading = 'auto'
  ),
  scores as (
    select e.user_id,
           p.display_name,
           count(qp.question_id) filter (where qp.first_attempt_correct) as first_correct,
           count(qp.question_id) as auto_seen,
           e.coverage_count,
           e.mastery_count,
           e.completed_at
    from public.enrollments e
    join public.profiles p on p.id = e.user_id
    left join public.question_progress qp
      on qp.enrollment_id = e.id
     and qp.question_id in (select id from auto_q)
    where e.subject_id = p_subject_id
    group by e.user_id, p.display_name, e.coverage_count, e.mastery_count, e.completed_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', user_id,
    'display_name', display_name,
    'first_correct', first_correct,
    'auto_seen', auto_seen,
    'coverage_count', coverage_count,
    'mastery_count', mastery_count,
    'completed_at', completed_at
  ) order by first_correct desc, mastery_count desc, coverage_count desc), '[]'::jsonb)
  from (
    select *
    from scores
    order by first_correct desc, mastery_count desc, coverage_count desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ) s;
$$;

-- ---------- RPC: الشهادة ----------
create or replace function public.claim_certificate(p_subject_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_enrollment public.enrollments;
  v_settings public.subject_settings;
  v_final_score numeric(5,2);
  v_code text;
  v_cert public.certificates;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;

  select * into v_enrollment
  from public.enrollments
  where user_id = v_uid and subject_id = p_subject_id;
  if not found then raise exception 'NOT_ENROLLED'; end if;

  select * into v_settings
  from public.subject_settings
  where subject_id = p_subject_id;

  if v_enrollment.total_questions = 0 then
    raise exception 'NO_QUESTIONS';
  end if;
  if v_enrollment.coverage_count < v_enrollment.total_questions then
    raise exception 'COVERAGE_INCOMPLETE';
  end if;
  if v_enrollment.mastery_count < ceil(v_enrollment.total_questions * v_settings.mastery_threshold)::int then
    raise exception 'MASTERY_INCOMPLETE';
  end if;

  if v_settings.final_exam_required then
    select score into v_final_score
    from public.final_exam_attempts
    where enrollment_id = v_enrollment.id and passed
    order by submitted_at desc nulls last
    limit 1;
    if v_final_score is null then
      raise exception 'FINAL_EXAM_REQUIRED';
    end if;
  end if;

  select * into v_cert
  from public.certificates
  where user_id = v_uid and subject_id = p_subject_id;
  if found then
    return jsonb_build_object(
      'id', v_cert.id,
      'code', v_cert.code,
      'issued_at', v_cert.issued_at,
      'coverage_count', v_cert.coverage_count,
      'mastery_count', v_cert.mastery_count,
      'final_score', v_cert.final_score
    );
  end if;

  v_code := encode(gen_random_bytes(8), 'hex');

  insert into public.certificates
    (user_id, subject_id, coverage_count, mastery_count, final_score, code)
  values
    (v_uid, p_subject_id, v_enrollment.coverage_count, v_enrollment.mastery_count, v_final_score, v_code)
  returning * into v_cert;

  return jsonb_build_object(
    'id', v_cert.id,
    'code', v_cert.code,
    'issued_at', v_cert.issued_at,
    'coverage_count', v_cert.coverage_count,
    'mastery_count', v_cert.mastery_count,
    'final_score', v_cert.final_score
  );
end;
$$;

-- ---------- صلاحيات الدوال ----------
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

revoke execute on function public.owns_enrollment(uuid) from public, anon;
grant execute on function public.owns_enrollment(uuid) to authenticated;

revoke execute on function public.owns_attempt(uuid) from public, anon;
grant execute on function public.owns_attempt(uuid) to authenticated;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.stage_payload(uuid) from public, anon, authenticated;

revoke execute on function public.join_subject(uuid) from public, anon;
grant execute on function public.join_subject(uuid) to authenticated;

revoke execute on function public.start_stage(uuid) from public, anon;
grant execute on function public.start_stage(uuid) to authenticated;

revoke execute on function public.submit_stage(uuid, jsonb) from public, anon;
grant execute on function public.submit_stage(uuid, jsonb) to authenticated;

revoke execute on function public.get_subject_progress(uuid) from public, anon;
grant execute on function public.get_subject_progress(uuid) to authenticated;

revoke execute on function public.get_leaderboard(uuid, int) from public, anon;
grant execute on function public.get_leaderboard(uuid, int) to authenticated;

revoke execute on function public.claim_certificate(uuid) from public, anon;
grant execute on function public.claim_certificate(uuid) to authenticated;

-- ---------- إعدادات عامة ----------
insert into public.settings (key, value, description) values
  ('app_name', to_jsonb('مراحل البكالوريا'::text), 'اسم التطبيق'),
  ('default_stage_size', '5'::jsonb, 'سقف أسئلة المرحلة'),
  ('default_session_stages', '10'::jsonb, 'عدد المراحل في الجلسة'),
  ('default_interval_minutes', '120'::jsonb, 'الفاصل بين الجلسات بالدقائق'),
  ('default_mastery_threshold', '1.0'::jsonb, 'نسبة الإتقان المطلوبة للشهادة')
on conflict (key) do nothing;
