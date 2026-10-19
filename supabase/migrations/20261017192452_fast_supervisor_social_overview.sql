-- One server-only round trip replaces authentication + settings + groups +
-- two message reads + likes. Existing partial feed indexes cover the reads.
create or replace function public.edge_supervisor_social_overview(
  p_token_hash text, p_stage text, p_group_id uuid default null
) returns jsonb
language plpgsql stable security invoker set search_path = pg_catalog
as $$
declare
  v_groups jsonb;
  v_group uuid;
  v_enabled boolean;
  v_tweets jsonb;
  v_chat jsonb;
  v_feeds jsonb;
begin
  if not exists(select 1 from public.edge_supervisor_session(p_token_hash)) then
    return null;
  end if;
  if p_stage is null or p_stage not in ('elementary_456','middle','secondary') then
    return jsonb_build_object('success',false,'error','اختر المرحلة أولًا');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name) order by g.name,g.id),'[]'::jsonb)
    into v_groups from public.groups g where g.stage_category=p_stage and g.active;
  select g.id into v_group from public.groups g
    where g.stage_category=p_stage and g.active and (p_group_id is null or g.id=p_group_id)
    order by g.name,g.id limit 1;
  select coalesce((select s.enabled from public.tweet_stage_settings s where s.stage_category=p_stage),false) into v_enabled;

  with latest as materialized (
    select m.id,m.body,m.author_name,m.author_student_id,m.author_supervisor_id,m.created_at,m.pinned_at
    from public.hawaya_social_messages m
    where m.stage_category=p_stage and m.channel='tweets' and m.group_id is null and m.deleted_at is null
    order by m.pinned_at desc nulls last,m.created_at desc,m.id desc limit 100
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',m.id,'name',m.author_name,'text',m.body,'createdAt',m.created_at,'pinned',m.pinned_at is not null,
    'imageUrl',coalesce(s.photo_url,''),'supervisor',m.author_supervisor_id is not null,
    'likes',(select count(*) from public.hawaya_social_likes l where l.message_id=m.id),'liked',false,'mine',false
  ) order by m.pinned_at desc nulls last,m.created_at desc,m.id desc),'[]'::jsonb)
  into v_tweets from latest m left join public.students s on s.id=m.author_student_id;
  v_feeds:=jsonb_build_array(jsonb_build_object('channel','tweets','groupId',null,'messages',v_tweets));

  if v_group is not null then
    with latest as materialized (
      select m.id,m.body,m.author_name,m.author_student_id,m.author_supervisor_id,m.created_at,m.pinned_at
      from public.hawaya_social_messages m
      where m.group_id=v_group and m.stage_category=p_stage and m.channel='chat' and m.deleted_at is null
      order by m.created_at desc,m.id desc limit 100
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',m.id,'name',m.author_name,'text',m.body,'createdAt',m.created_at,'pinned',m.pinned_at is not null,
      'imageUrl',coalesce(s.photo_url,''),'supervisor',m.author_supervisor_id is not null,
      'likes',0,'liked',false,'mine',false
    ) order by m.created_at,m.id),'[]'::jsonb)
    into v_chat from latest m left join public.students s on s.id=m.author_student_id;
    v_feeds:=v_feeds||jsonb_build_array(jsonb_build_object('channel','chat','groupId',v_group,'messages',v_chat));
  end if;
  return jsonb_build_object('success',true,'stage',p_stage,
    'stageLabel',case p_stage when 'middle' then 'متوسط' when 'secondary' then 'ثانوي' else 'رابع+خامس+سادس' end,
    'enabled',v_enabled,'groups',v_groups,'feeds',v_feeds);
end;
$$;
revoke all on function public.edge_supervisor_social_overview(text,text,uuid) from public,anon,authenticated;
grant execute on function public.edge_supervisor_social_overview(text,text,uuid) to service_role;
