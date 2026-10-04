do $$
declare
  before_count bigint;
  before_marks bigint;
  before_points bigint;
  after_count bigint;
  after_marks bigint;
  after_points bigint;
begin
  select count(*),coalesce(sum(quantity),0),coalesce(sum(total_points),0)
    into before_count,before_marks,before_points from public.point_awards;
  insert into public.point_items(code,base_code,stage_category,name,points_per_mark,max_marks,limit_period,allowed_weekdays,active,sort_order,created_by)
    select source.code || '__' || stages.category,source.base_code,stages.category,source.name,source.points_per_mark,source.max_marks,source.limit_period,source.allowed_weekdays,source.active,source.sort_order,source.created_by
    from public.point_items source
    cross join (values ('middle'),('secondary')) stages(category)
    where source.stage_category is null;
  update public.point_items set stage_category='elementary_456' where stage_category is null;
  update public.point_awards award set point_item_id=target.id
    from public.point_items original, public.students student, public.point_items target
    where award.point_item_id=original.id and award.student_id=student.id
      and target.base_code=original.base_code
      and target.stage_category=case when student.grade like '%متوسط%' then 'middle' when student.grade like '%ثانوي%' then 'secondary' else 'elementary_456' end
      and award.point_item_id<>target.id;
  select count(*),coalesce(sum(quantity),0),coalesce(sum(total_points),0)
    into after_count,after_marks,after_points from public.point_awards;
  if (before_count,before_marks,before_points) is distinct from (after_count,after_marks,after_points) then
    raise exception 'Point history changed during stage migration';
  end if;
end $$;
alter table public.point_items alter column stage_category set not null;
