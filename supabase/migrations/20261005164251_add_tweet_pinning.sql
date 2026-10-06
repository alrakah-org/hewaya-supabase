alter table public.hawaya_social_messages
 add column pinned_at timestamptz,
 add column pinned_by uuid references app_private.supervisors(id),
 add constraint social_pin_tweets_only check(channel='tweets' or pinned_at is null),
 add constraint social_pin_actor check((pinned_at is null)=(pinned_by is null));
create index hawaya_social_pinned_feed on public.hawaya_social_messages
(stage_category,pinned_at desc nulls last,created_at desc,id desc)
where channel='tweets' and deleted_at is null;