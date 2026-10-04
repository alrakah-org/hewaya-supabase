create table public.supervisor_social_preview (
id uuid primary key default gen_random_uuid(),
author_name text not null,
body text not null check(char_length(body) between 1 and 500),
channel text not null check(channel in ('tweets','chat')),
group_id uuid references public.groups(id),
created_at timestamptz not null default now(),
check((channel='tweets' and group_id is null) or (channel='chat' and group_id is not null))
);
alter table public.supervisor_social_preview enable row level security;
revoke all on public.supervisor_social_preview from anon,authenticated;
grant all on public.supervisor_social_preview to service_role;
create index supervisor_social_preview_feed on public.supervisor_social_preview(channel,group_id,created_at desc);