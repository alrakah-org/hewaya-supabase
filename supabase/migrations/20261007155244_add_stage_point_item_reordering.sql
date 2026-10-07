create or replace function public.edge_move_point_item(p_token_hash text,p_stage text,p_code text,p_direction text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare keys text[]; pos integer; dest integer;
begin
 if not exists(select 1 from public.edge_supervisor_session(p_token_hash)) then
  return jsonb_build_object('success',false,'error','انتهت الجلسة، سجل الدخول مجددًا');
 end if;
 if p_stage not in ('elementary_456','middle','secondary') or p_direction not in ('up','down') then
  return jsonb_build_object('success',false,'error','المرحلة أو الاتجاه غير صحيح');
 end if;
 perform pg_advisory_xact_lock(hashtext('hawaya-point-order:' || p_stage));
 perform 1 from public.point_items where stage_category=p_stage for update;
 select array_agg(code order by sort_order,created_at,code) into keys from public.point_items where stage_category=p_stage;
 pos:=array_position(keys,p_code);
 if pos is null then return jsonb_build_object('success',false,'error','البند غير موجود في المرحلة المحددة'); end if;
 dest:=pos+case when p_direction='up' then -1 else 1 end;
 if dest<1 or dest>array_length(keys,1) then return jsonb_build_object('success',true,'stage',p_stage); end if;
 update public.point_items p set sort_order=10*(case when k.n=pos then dest when k.n=dest then pos else k.n end)
 from unnest(keys) with ordinality as k(code,n) where p.code=k.code and p.stage_category=p_stage;
 return jsonb_build_object('success',true,'stage',p_stage);
end; $$;
revoke all on function public.edge_move_point_item(text,text,text,text) from public,anon,authenticated;
grant execute on function public.edge_move_point_item(text,text,text,text) to service_role;