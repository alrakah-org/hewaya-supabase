alter table public.point_items add column stage_category text;
alter table public.point_items add column base_code text;
update public.point_items set base_code=code;
alter table public.point_items alter column base_code set not null;
alter table public.point_items add constraint point_items_stage_category_check check (stage_category is null or stage_category in ('elementary_456','middle','secondary'));
create unique index point_items_stage_base_key on public.point_items(stage_category,base_code);
comment on column public.point_items.stage_category is 'Independent item configuration per education stage; null only during initial migration.';
comment on column public.point_items.base_code is 'Stable family key preserving weekly counts across legacy clients and stage changes.';
