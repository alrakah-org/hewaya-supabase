-- Stage-specific points multiplier (×2)
-- Applied to the live Supabase project uv... via SQL.
-- Safe to re-run: columns, settings, and triggers are idempotent.

create table if not exists public.points_multiplier_settings (
  stage_category text primary key check (stage_category in ('elementary_456','middle','secondary')),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.points_multiplier_settings(stage_category, enabled)
values ('elementary_456',false),('middle',false),('secondary',false)
on conflict (stage_category) do nothing;

alter table public.points_multiplier_settings enable row level security;
revoke all on public.points_multiplier_settings from anon, authenticated;
grant select, insert, update on public.points_multiplier_settings to service_role;

alter table public.point_awards add column if not exists points_multiplier smallint not null default 1 check (points_multiplier in (1,2));
alter table public.point_transactions add column if not exists points_multiplier smallint not null default 1 check (points_multiplier in (1,2));
alter table public.attendance add column if not exists points_multiplier smallint not null default 1 check (points_multiplier in (1,2));

create or replace function public.apply_stage_points_multiplier()
returns trigger language plpgsql set search_path = public as $$
declare v_stage text; v_enabled boolean := false;
begin
  select s.stage_category into v_stage from public.students s where s.id = new.student_id;
  if v_stage is not null then
    select coalesce(ms.enabled, false) into v_enabled
    from public.points_multiplier_settings ms where ms.stage_category = v_stage;
  end if;
  if coalesce(v_enabled, false) then
    if tg_table_name = 'point_awards' then new.unit_points := new.unit_points * 2;
    elsif tg_table_name = 'point_transactions' then new.amount := new.amount * 2;
    elsif tg_table_name = 'attendance' then new.points := new.points * 2;
    end if;
    new.points_multiplier := 2;
  else new.points_multiplier := 1;
  end if;
  return new;
end; $$;

drop trigger if exists trg_point_awards_stage_multiplier on public.point_awards;
create trigger trg_point_awards_stage_multiplier before insert on public.point_awards
for each row execute function public.apply_stage_points_multiplier();
drop trigger if exists trg_point_transactions_stage_multiplier on public.point_transactions;
create trigger trg_point_transactions_stage_multiplier before insert on public.point_transactions
for each row execute function public.apply_stage_points_multiplier();
drop trigger if exists trg_attendance_stage_multiplier on public.attendance;
create trigger trg_attendance_stage_multiplier before insert on public.attendance
for each row execute function public.apply_stage_points_multiplier();
