-- Official feeds are separate from the supervisors' preview.
create table public.hawaya_social_messages (
 id uuid primary key default gen_random_uuid(),
 stage_category text not null check(stage_category in ('elementary_456','middle','secondary')),
 channel text not null check(channel in ('tweets','chat')),
 group_id uuid references public.groups(id),
 author_student_id bigint references public.students(id),
 author_supervisor_id uuid references app_private.supervisors(id),
 author_name text not null,
 body text not null check(char_length(body) between 1 and 500),
 created_at timestamptz not null default now(),
 deleted_at timestamptz,
 check((author_student_id is not null)::integer+(author_supervisor_id is not null)::integer=1),
 check((channel='tweets' and group_id is null) or (channel='chat' and group_id is not null))
);
create index hawaya_social_stage_feed on public.hawaya_social_messages(stage_category,created_at desc,id desc) where channel='tweets' and deleted_at is null;
create index hawaya_social_group_feed on public.hawaya_social_messages(group_id,created_at desc,id desc) where channel='chat' and deleted_at is null;
create table public.hawaya_social_likes (
 message_id uuid not null references public.hawaya_social_messages(id) on delete cascade,
 student_id bigint not null references public.students(id),
 created_at timestamptz not null default now(),
 primary key(message_id,student_id)
);
alter table public.hawaya_social_messages enable row level security;
alter table public.hawaya_social_likes enable row level security;
revoke all on public.hawaya_social_messages,public.hawaya_social_likes from public,anon,authenticated;
grant all on public.hawaya_social_messages,public.hawaya_social_likes to service_role;
-- Access uses verified student credentials or supervisor sessions in hawaya-api.
update public.tweet_stage_settings set enabled=true,updated_at=now();
