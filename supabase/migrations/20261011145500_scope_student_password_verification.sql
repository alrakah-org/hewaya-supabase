-- Resolve the requested active student before running the expensive password check.
-- MATERIALIZED prevents the planner from pushing crypt() down to a scan of all
-- credentials, which previously caused repeated statement timeouts.
create or replace function public.edge_student_verify(p_code text, p_password text)
returns bigint
language sql
security definer
set search_path = public, app_private, extensions, pg_temp
as $$
  with candidate as materialized (
    select s.id, c.password_hash
    from public.students s
    join app_private.student_credentials c on c.student_id = s.id
    where s.student_code = p_code
      and s.active
    limit 1
  )
  select id
  from candidate
  where password_hash is not null
    and extensions.crypt(p_password, password_hash) = password_hash;
$$;

-- Preserve the existing server-only verification boundary. No client role can
-- call this function or read credential hashes directly.
revoke all on function public.edge_student_verify(text,text) from public, anon, authenticated;
grant execute on function public.edge_student_verify(text,text) to service_role;
