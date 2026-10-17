-- Browser subscriptions and delivery credentials are server-only. No keys or
-- existing account credentials are copied into the frontend or migration.
create table app_private.push_config (
  id boolean primary key default true check (id),
  vapid_public text,
  vapid_private text,
  gateway_key text,
  worker_secret text not null default encode(extensions.gen_random_bytes(32),'hex'),
  last_wake_at timestamptz,
  enabled boolean not null default true
);
insert into app_private.push_config(id) values(true);

create table app_private.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  role text not null check(role in ('student','supervisor')),
  student_id bigint references public.students(id) on delete cascade,
  supervisor_id uuid references app_private.supervisors(id) on delete cascade,
  session_hash text,
  endpoint text not null check(length(endpoint) between 20 and 2048),
  endpoint_hash text not null unique,
  keys jsonb not null,
  device_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '45 days',
  check ((role='student' and student_id is not null and supervisor_id is null and session_hash is null)
      or (role='supervisor' and student_id is null and supervisor_id is not null and session_hash is not null))
);
create index push_subscriptions_student_idx on app_private.push_subscriptions(student_id) where student_id is not null;
create index push_subscriptions_supervisor_idx on app_private.push_subscriptions(supervisor_id) where supervisor_id is not null;

create table app_private.push_queue (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references app_private.push_subscriptions(id) on delete cascade,
  kind text not null check(kind in ('points','tweets','chat')),
  scope_key text not null,
  message_id uuid references public.hawaya_social_messages(id) on delete cascade,
  revision bigint not null default 1,
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  expires_at timestamptz not null default now()+interval '1 day',
  unique(subscription_id,scope_key)
);
create index push_queue_ready_idx on app_private.push_queue(available_at) where attempts<6;
create index push_queue_message_idx on app_private.push_queue(message_id) where message_id is not null;

alter table app_private.push_config enable row level security;
alter table app_private.push_subscriptions enable row level security;
alter table app_private.push_queue enable row level security;
revoke all on app_private.push_config,app_private.push_subscriptions,app_private.push_queue from public,anon,authenticated;
grant usage on schema app_private to service_role;
grant select,insert,update,delete on app_private.push_config,app_private.push_subscriptions,app_private.push_queue to service_role;

create function public.edge_push_config() returns jsonb
language sql security invoker set search_path=pg_catalog as $$
  select to_jsonb(c) from app_private.push_config c where id;
$$;
create function public.edge_push_initialize(p_public text,p_private text,p_gateway text) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if length(p_public)<>87 or length(p_private)<>43 or length(p_gateway)<20 then
    raise exception 'Invalid push configuration';
  end if;
  update app_private.push_config set
    vapid_public=coalesce(vapid_public,p_public),vapid_private=coalesce(vapid_private,p_private),gateway_key=p_gateway where id;
  return public.edge_push_config();
end;
$$;

create function public.edge_push_register(p_role text,p_student bigint,p_supervisor uuid,p_session_hash text,p_endpoint text,p_keys jsonb,p_device_hash text)
returns uuid language plpgsql security invoker set search_path=pg_catalog as $$
declare previous app_private.push_subscriptions; result uuid; digest text;
begin
  digest:=encode(extensions.digest(p_endpoint,'sha256'),'hex');
  -- Serialize registrations for the same endpoint, including its first insert.
  perform pg_advisory_xact_lock(hashtextextended(digest,0));
  select * into previous from app_private.push_subscriptions where endpoint_hash=digest for update;
  if found then
    if previous.device_hash<>p_device_hash then raise exception 'Device subscription mismatch'; end if;
    if previous.role=p_role and previous.student_id is not distinct from p_student and previous.supervisor_id is not distinct from p_supervisor then
      update app_private.push_subscriptions set keys=p_keys,session_hash=p_session_hash,updated_at=now(),expires_at=now()+interval '45 days' where id=previous.id;
      return previous.id;
    end if;
    -- Account switches invalidate the previous binding and all queued deliveries.
    delete from app_private.push_subscriptions where id=previous.id;
  end if;
  insert into app_private.push_subscriptions(role,student_id,supervisor_id,session_hash,endpoint,endpoint_hash,keys,device_hash)
  values(p_role,p_student,p_supervisor,p_session_hash,p_endpoint,digest,p_keys,p_device_hash) returning id into result;
  return result;
end;
$$;
create function public.edge_push_unregister(p_endpoint text,p_device_hash text) returns void
language sql security invoker set search_path=pg_catalog as $$
  delete from app_private.push_subscriptions where endpoint_hash=encode(extensions.digest(p_endpoint,'sha256'),'hex') and device_hash=p_device_hash;
$$;

create function app_private.push_can_receive(p_subscription uuid,p_kind text,p_message uuid) returns boolean
language sql stable security invoker set search_path=pg_catalog as $$
  select exists(
    select 1 from app_private.push_subscriptions sub
    left join public.students student on student.id=sub.student_id
    left join public.hawaya_social_messages message on message.id=p_message
    where sub.id=p_subscription and sub.expires_at>now() and (
      (sub.role='student' and student.active and (
        p_kind='points' or (
          message.deleted_at is null and message.id is not null
          and sub.student_id is distinct from message.author_student_id
          and exists(select 1 from public.tweet_stage_settings settings where settings.stage_category=message.stage_category and settings.enabled)
          and (case when student.grade like '%متوسط%' then 'middle' when student.grade like '%ثانوي%' then 'secondary' else 'elementary_456' end)=message.stage_category
          and ((p_kind='tweets' and message.channel='tweets') or
            (p_kind='chat' and message.channel='chat' and exists(
              select 1 from public.group_memberships membership join public.groups g on g.id=membership.group_id
              where membership.student_id=sub.student_id and membership.group_id=message.group_id and membership.left_at is null and g.active and g.stage_category=message.stage_category
            )))
        )
      )) or
      (sub.role='supervisor' and p_kind in ('tweets','chat') and message.id is not null and message.deleted_at is null
        and sub.supervisor_id is distinct from message.author_supervisor_id
        and (p_kind='tweets' or exists(select 1 from public.groups g where g.id=message.group_id and g.active and g.stage_category=message.stage_category))
        and exists(select 1 from public.edge_supervisor_session(sub.session_hash) session where session.supervisor_id=sub.supervisor_id))
    )
  );
$$;

create function public.edge_push_claim(p_limit integer default 50) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare result jsonb;
begin
  delete from app_private.push_subscriptions where expires_at<=now();
  delete from app_private.push_queue q where q.expires_at<=now() or (q.attempts>=6 and (q.lease_until is null or q.lease_until<now())) or not app_private.push_can_receive(q.subscription_id,q.kind,q.message_id);
  with ready as (
    select q.id from app_private.push_queue q where q.attempts<6 and q.available_at<=now() and (q.lease_until is null or q.lease_until<now())
    order by q.available_at limit least(greatest(p_limit,1),100) for update skip locked
  ), claimed as (
    update app_private.push_queue q set lease_until=now()+interval '5 minutes',attempts=attempts+1
    from ready where q.id=ready.id returning q.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',q.id,'revision',q.revision,'subscriptionId',sub.id,'role',sub.role,'endpoint',sub.endpoint,'keys',sub.keys,
    'kind',q.kind,'stage',message.stage_category,'groupId',message.group_id
  )),'[]'::jsonb) into result from claimed q join app_private.push_subscriptions sub on sub.id=q.subscription_id
  left join public.hawaya_social_messages message on message.id=q.message_id;
  return result;
end;
$$;
create function public.edge_push_finish(p_id uuid,p_revision bigint,p_result text) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare item app_private.push_queue;
begin
  select * into item from app_private.push_queue where id=p_id for update;
  if not found then return; end if;
  if p_result='expired' then
    delete from app_private.push_subscriptions where id=item.subscription_id;
  elsif item.revision<>p_revision then
    update app_private.push_queue set lease_until=null,available_at=now(),attempts=0 where id=p_id;
  elsif p_result='sent' then
    delete from app_private.push_queue where id=p_id;
  else
    update app_private.push_queue set lease_until=null,available_at=now()+make_interval(secs=>least(1800,30*power(2,attempts)::integer)) where id=p_id;
  end if;
end;
$$;

-- Only the server function can use these RPCs; browsers authenticate with that
-- function using the app's existing student / supervisor verification.
revoke all on function public.edge_push_config(),public.edge_push_initialize(text,text,text),public.edge_push_register(text,bigint,uuid,text,text,jsonb,text),public.edge_push_unregister(text,text),public.edge_push_claim(integer),public.edge_push_finish(uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.edge_push_config(),public.edge_push_initialize(text,text,text),public.edge_push_register(text,bigint,uuid,text,text,jsonb,text),public.edge_push_unregister(text,text),public.edge_push_claim(integer),public.edge_push_finish(uuid,bigint,text) to service_role;
revoke all on function app_private.push_can_receive(uuid,text,uuid) from public,anon,authenticated;
grant execute on function app_private.push_can_receive(uuid,text,uuid) to service_role;

-- Async HTTP starts after commit. A cron fallback retries queued work when a
-- push provider or the Edge Function is briefly unavailable.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create function app_private.wake_push_worker(p_force boolean default false) returns void
language plpgsql security invoker set search_path=pg_catalog as $$
declare config app_private.push_config;
begin
  if not exists(select 1 from app_private.push_queue where available_at<=now() and (lease_until is null or lease_until<now())) then return; end if;
  update app_private.push_config set last_wake_at=now()
  where id and enabled and gateway_key is not null and vapid_public is not null
    and (p_force or last_wake_at is null or last_wake_at<now()-interval '2 seconds') returning * into config;
  if not found then return; end if;
  perform net.http_post(
    url:='https://uvcotcfemolqwkgypyeq.supabase.co/functions/v1/hawaya-push',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||config.gateway_key,'apikey',config.gateway_key,'x-hawaya-push-worker',config.worker_secret),
    body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=60000
  );
exception when others then
  raise log 'Hawaya push wake failed (%)',SQLSTATE;
end;
$$;

create function app_private.enqueue_social_push() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if new.deleted_at is not null then return new; end if;
  insert into app_private.push_queue(subscription_id,kind,scope_key,message_id)
  select sub.id,new.channel,'message:'||new.id::text,new.id from app_private.push_subscriptions sub
  where app_private.push_can_receive(sub.id,new.channel,new.id)
  on conflict(subscription_id,scope_key) do nothing;
  perform app_private.wake_push_worker();
  return new;
exception when others then
  -- Delivery failures must not prevent saving a message.
  raise log 'Hawaya social push enqueue failed (%)',SQLSTATE;
  return new;
end;
$$;
create trigger hawaya_social_push_insert after insert on public.hawaya_social_messages
for each row execute function app_private.enqueue_social_push();

create function app_private.enqueue_points_push(p_student bigint) returns void
language sql security invoker set search_path=pg_catalog as $$
  insert into app_private.push_queue(subscription_id,kind,scope_key)
  select sub.id,'points','points' from app_private.push_subscriptions sub
  where sub.student_id=p_student and app_private.push_can_receive(sub.id,'points',null)
  on conflict(subscription_id,scope_key) do update set
    revision=app_private.push_queue.revision+1,attempts=0,available_at=now(),expires_at=now()+interval '1 day';
$$;
create function app_private.enqueue_points_change_push() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
declare previous jsonb; current_row jsonb; previous_amount integer; current_amount integer; amount_column text:=tg_argv[0];
begin
  if tg_op<>'INSERT' then previous:=to_jsonb(old); end if;
  if tg_op<>'DELETE' then current_row:=to_jsonb(new); end if;
  previous_amount:=coalesce((previous->>amount_column)::integer,0);
  current_amount:=coalesce((current_row->>amount_column)::integer,0);
  if previous_amount<>current_amount or previous->>'student_id' is distinct from current_row->>'student_id' then
    if previous_amount<>0 then perform app_private.enqueue_points_push((previous->>'student_id')::bigint); end if;
    if current_amount<>0 and (previous_amount=0 or previous->>'student_id' is distinct from current_row->>'student_id') then
      perform app_private.enqueue_points_push((current_row->>'student_id')::bigint);
    end if;
    perform app_private.wake_push_worker();
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
exception when others then
  raise log 'Hawaya points push enqueue failed (%)',SQLSTATE;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
create trigger hawaya_point_awards_push after insert or update or delete on public.point_awards
for each row execute function app_private.enqueue_points_change_push('total_points');
create trigger hawaya_point_transactions_push after insert or update or delete on public.point_transactions
for each row execute function app_private.enqueue_points_change_push('amount');
create trigger hawaya_attendance_push after insert or update or delete on public.attendance
for each row execute function app_private.enqueue_points_change_push('points');

create function app_private.revoke_student_push_on_password_change() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if new.password_hash is distinct from old.password_hash then
    delete from app_private.push_subscriptions where student_id=new.student_id;
  end if;
  return new;
end;
$$;
create trigger hawaya_password_change_push after update of password_hash on app_private.student_credentials
for each row execute function app_private.revoke_student_push_on_password_change();

revoke all on function app_private.wake_push_worker(boolean),app_private.enqueue_social_push(),app_private.enqueue_points_push(bigint),app_private.enqueue_points_change_push(),app_private.revoke_student_push_on_password_change() from public,anon,authenticated;
grant execute on function app_private.wake_push_worker(boolean),app_private.enqueue_social_push(),app_private.enqueue_points_push(bigint),app_private.enqueue_points_change_push(),app_private.revoke_student_push_on_password_change() to service_role;

select cron.schedule('hawaya-push-retry','* * * * *','select app_private.wake_push_worker(true);');
