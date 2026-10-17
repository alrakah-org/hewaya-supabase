-- Legacy numeric IDs may be printed with a leading zero. Prefer the exact
-- stored identifier, then its unpadded numeric form, without checking a second
-- account's password or altering any existing credential.
create or replace function public.edge_student_verify(p_code text,p_password text)
returns bigint language sql security definer set search_path=pg_catalog as $$
  with input as (
    select translate(btrim(p_code),'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789') code
  ), normalized as (
    select code,case when code ~ '^[0-9]+$' then coalesce(nullif(ltrim(code,'0'),''),'0') else code end canonical from input
  ), selected as materialized (
    select s.id,s.active from public.students s cross join normalized n
    where s.student_code in(n.code,n.canonical)
    order by case when s.student_code=n.code then 0 else 1 end
    limit 1
  ), candidate as materialized (
    select s.id,c.password_hash from selected s
    join app_private.student_credentials c on c.student_id=s.id where s.active
  )
  select id from candidate where password_hash is not null
    and extensions.crypt(translate(p_password,'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'),password_hash)=password_hash;
$$;
revoke all on function public.edge_student_verify(text,text) from public,anon,authenticated;
grant execute on function public.edge_student_verify(text,text) to service_role;
