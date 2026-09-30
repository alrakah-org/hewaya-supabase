create extension if not exists pgcrypto;

alter table app_private.student_credentials
  add column if not exists password_hash text;

update app_private.student_credentials
set password_hash = crypt(login_password, gen_salt('bf', 10))
where password_hash is null and login_password is not null;

drop function if exists public.edge_get_student_password(bigint);

create or replace function public.edge_set_student_password(p_student_id bigint, p_password text)
returns void
language sql
security definer
set search_path = public, app_private, extensions, pg_temp
as $$
  insert into app_private.student_credentials(student_id,password_hash)
  values(p_student_id, crypt(p_password, gen_salt('bf', 10)))
  on conflict(student_id) do update
  set password_hash=excluded.password_hash,updated_at=now();
$$;

create or replace function public.edge_student_verify(p_code text, p_password text)
returns bigint
language sql
security definer
set search_path = public, app_private, extensions, pg_temp
as $$
  select s.id
  from public.students s
  join app_private.student_credentials c on c.student_id=s.id
  where s.student_code=p_code
    and c.password_hash is not null
    and crypt(p_password,c.password_hash)=c.password_hash
    and s.active
  limit 1;
$$;

alter table app_private.student_credentials drop column if exists login_password;

alter table app_private.student_credentials enable row level security;
alter table app_private.supervisors enable row level security;
alter table app_private.api_sessions enable row level security;

revoke all on schema app_private from public, anon, authenticated;
revoke all on all tables in schema app_private from public, anon, authenticated;
revoke all on all sequences in schema app_private from public, anon, authenticated;
revoke all on function public.edge_set_student_password(bigint,text) from public, anon, authenticated;
revoke all on function public.edge_student_verify(text,text) from public, anon, authenticated;
grant execute on function public.edge_set_student_password(bigint,text) to service_role;
grant execute on function public.edge_student_verify(text,text) to service_role;

update public.program_settings
set program_start_date='2026-09-06', first_visible_week=2, updated_at=now()
where id=1;
