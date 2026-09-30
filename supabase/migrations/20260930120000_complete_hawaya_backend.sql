create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create extension if not exists pgcrypto;

create table if not exists app_private.student_credentials (
  student_id bigint primary key references public.students(id) on delete cascade,
  login_password text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_private.supervisors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  pin_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_private.api_sessions (
  id uuid primary key default gen_random_uuid(),
  supervisor_id uuid not null references app_private.supervisors(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists api_sessions_expiry_idx on app_private.api_sessions(expires_at);
create index if not exists api_sessions_supervisor_idx on app_private.api_sessions(supervisor_id);

create table if not exists public.point_transactions (
  id bigint generated always as identity primary key,
  student_id bigint not null references public.students(id) on delete cascade,
  amount integer not null check (amount <> 0),
  reason text not null check (char_length(reason) between 1 and 120),
  source text not null default 'supervisor' check (source in ('supervisor','import','system')),
  supervisor_name text,
  week_number integer not null check (week_number >= 1),
  activity_date date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists point_transactions_student_week_idx on public.point_transactions(student_id, week_number);
create index if not exists point_transactions_date_idx on public.point_transactions(activity_date);
alter table public.point_transactions enable row level security;
revoke all on public.point_transactions from anon, authenticated;
drop policy if exists point_transactions_no_client_access on public.point_transactions;
create policy point_transactions_no_client_access on public.point_transactions
for all to anon, authenticated using (false) with check (false);

revoke execute on function public.submit_student_attendance(text) from public, anon, authenticated;
revoke execute on function public.submit_student_points(text,integer,date) from public, anon, authenticated;

insert into public.program_settings(id) values (1) on conflict (id) do nothing;

insert into public.point_items(code,name,points_per_mark,max_marks,limit_period,allowed_weekdays,sort_order,active)
values
 ('circle_achievement','إنجاز الحلقة',3000,2,'weekly',array[0,2]::smallint[],10,true),
 ('lesson','الدرس',200,1,'weekly',array[0,1,2,3,4,5,6]::smallint[],20,true),
 ('course','الدورة',200,1,'weekly',array[0,1,2,3,4,5,6]::smallint[],30,true),
 ('cultural','الثقافي',200,1,'weekly',array[0,1,2,3,4,5,6]::smallint[],40,true),
 ('sports','الرياضي',100,1,'weekly',array[0,1,2,3,4,5,6]::smallint[],50,true),
 ('creativity','الإبداع',300,5,'weekly',array[0,1,2,3,4,5,6]::smallint[],60,true),
 ('generosity','الكرم',300,6,'weekly',array[0,1,2,3,4,5,6]::smallint[],70,true),
 ('adhan_word','الأذان والكلمة',300,3,'weekly',array[0,1,2,3,4,5,6]::smallint[],80,true)
on conflict (code) do update set
 name=excluded.name,
 points_per_mark=excluded.points_per_mark,
 max_marks=excluded.max_marks,
 limit_period=excluded.limit_period,
 allowed_weekdays=excluded.allowed_weekdays,
 sort_order=excluded.sort_order,
 active=excluded.active,
 updated_at=now();

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant usage on schema app_private to service_role;
grant all on all tables in schema app_private to service_role;

revoke all on all tables in schema app_private from public, anon, authenticated;

create or replace function public.edge_supervisor_login(
  p_name text, p_pin text, p_token_hash text, p_expires_at timestamptz
) returns table(supervisor_id uuid, supervisor_name text)
language plpgsql security definer
set search_path = public, app_private, pg_temp
as $$
begin
  delete from app_private.api_sessions where expires_at <= now();
  return query
  with matched as (
    select s.id, s.name from app_private.supervisors s
    where s.name = p_name and s.active and extensions.crypt(p_pin, s.pin_hash) = s.pin_hash
  ), inserted as (
    insert into app_private.api_sessions(supervisor_id, token_hash, expires_at)
    select id, p_token_hash, p_expires_at from matched
    returning app_private.api_sessions.supervisor_id
  )
  select m.id, m.name from matched m join inserted i on i.supervisor_id=m.id;
end;
$$;

create or replace function public.edge_supervisor_session(p_token_hash text)
returns table(supervisor_id uuid, supervisor_name text)
language sql security definer
set search_path = public, app_private, pg_temp
as $$
  select s.id, s.name
  from app_private.api_sessions x
  join app_private.supervisors s on s.id=x.supervisor_id
  where x.token_hash=p_token_hash and x.expires_at>now() and s.active;
$$;

create or replace function public.edge_student_verify(p_code text, p_password text)
returns bigint
language sql security definer
set search_path = public, app_private, pg_temp
as $$
  select s.id from public.students s
  join app_private.student_credentials c on c.student_id=s.id
  where s.student_code=p_code and c.login_password=p_password and s.active
  limit 1;
$$;

create or replace function public.edge_set_student_password(p_student_id bigint, p_password text)
returns void
language sql security definer
set search_path = public, app_private, pg_temp
as $$
  insert into app_private.student_credentials(student_id,login_password)
  values(p_student_id,p_password)
  on conflict(student_id) do update set login_password=excluded.login_password,updated_at=now();
$$;

create or replace function public.edge_get_student_password(p_student_id bigint)
returns text
language sql security definer
set search_path = public, app_private, pg_temp
as $$
  select login_password from app_private.student_credentials where student_id=p_student_id;
$$;

revoke all on function public.edge_supervisor_login(text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.edge_supervisor_session(text) from public, anon, authenticated;
revoke all on function public.edge_student_verify(text,text) from public, anon, authenticated;
revoke all on function public.edge_set_student_password(bigint,text) from public, anon, authenticated;
revoke all on function public.edge_get_student_password(bigint) from public, anon, authenticated;
grant execute on function public.edge_supervisor_login(text,text,text,timestamptz) to service_role;
grant execute on function public.edge_supervisor_session(text) to service_role;
grant execute on function public.edge_student_verify(text,text) to service_role;
grant execute on function public.edge_set_student_password(bigint,text) to service_role;
grant execute on function public.edge_get_student_password(bigint) to service_role;
