// Synthetic identities only. Exercise the deployed Edge route against real SQL
// in an isolated in-memory Postgres, including its session and role boundaries.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module'),{createHash,webcrypto}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const source=stripTypeScriptTypes(fs.readFileSync(__dirname+'/../supabase/functions/hawaya-social/index.ts','utf8'));
const migration=fs.readFileSync(__dirname+'/../supabase/migrations/'+fs.readdirSync(__dirname+'/../supabase/migrations').find(n=>n.endsWith('_fast_supervisor_social_overview.sql')),'utf8');
const uuid=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const hash=s=>createHash('sha256').update(s).digest('hex');
test('supervisor overview uses one authenticated database request',async t=>{
 const db=new PGlite();let handler;const calls=[];
 try{
  await db.exec(`
   create role anon;create role authenticated;create role service_role;
   create schema app_private;
   create table app_private.supervisors(id uuid primary key,name text,active boolean);
   create table app_private.api_sessions(supervisor_id uuid,token_hash text,expires_at timestamptz);
   create function public.edge_supervisor_session(p_token_hash text) returns table(supervisor_id uuid,supervisor_name text)
   language sql security definer set search_path=pg_catalog as $$select s.id,s.name from app_private.api_sessions x join app_private.supervisors s on s.id=x.supervisor_id where x.token_hash=p_token_hash and x.expires_at>now() and s.active$$;
   revoke all on function edge_supervisor_session(text) from public;grant execute on function edge_supervisor_session(text) to service_role;
   create table students(id bigint primary key,photo_url text);
   create table groups(id uuid primary key,name text,stage_category text,active boolean);
   create table tweet_stage_settings(stage_category text primary key,enabled boolean);
   create table hawaya_social_messages(id uuid primary key,stage_category text,channel text,group_id uuid,body text,author_name text,author_student_id bigint,author_supervisor_id uuid,created_at timestamptz,pinned_at timestamptz,deleted_at timestamptz);
   create table hawaya_social_likes(message_id uuid,student_id bigint,primary key(message_id,student_id));
   grant select on all tables in schema public to service_role;
   insert into app_private.supervisors values('${uuid(90)}','مشرف اختبار',true),('${uuid(91)}','غير نشط',false);
   insert into app_private.api_sessions values('${uuid(90)}','${hash('fixture')}',now()+interval '1 day'),('${uuid(90)}','${hash('expired')}',now()-interval '1 day'),('${uuid(91)}','${hash('inactive')}',now()+interval '1 day');
   insert into students values(1,'https://example.test/avatar.jpg');
   insert into groups values('${uuid(1)}','A','middle',true),('${uuid(2)}','B','middle',true),('${uuid(3)}','C','secondary',true),('${uuid(4)}','D','middle',false);
   insert into tweet_stage_settings values('middle',true),('secondary',false);
   insert into hawaya_social_messages(id,stage_category,channel,group_id,body,author_name,author_student_id,created_at) values
    ('${uuid(10)}','middle','tweets',null,'عام','طالب',1,'2026-10-17 10:00Z'),
    ('${uuid(11)}','middle','chat','${uuid(1)}','قديم','طالب',1,'2026-10-17 10:00Z'),
    ('${uuid(12)}','middle','chat','${uuid(1)}','جديد','طالب',1,'2026-10-17 11:00Z'),
    ('${uuid(13)}','secondary','tweets',null,'مرحلة أخرى','طالب',1,'2026-10-17 12:00Z'),
    ('${uuid(14)}','secondary','chat','${uuid(3)}','مجموعة أخرى','طالب',1,'2026-10-17 12:00Z'),
    ('${uuid(15)}','middle','chat','${uuid(2)}','ثانية','طالب',1,'2026-10-17 12:00Z');
   insert into hawaya_social_likes values('${uuid(10)}',1),('${uuid(10)}',2);
  `);
  await db.exec(migration);
  vm.runInNewContext(source,{Deno:{env:{get:n=>n==='SUPABASE_URL'?'https://fixture.test':'fixture-key'},serve:f=>handler=f},Headers,Request,Response,URL,TextEncoder,crypto:webcrypto,console,setTimeout,
   fetch:async(url,init)=>{
    const body=JSON.parse(init.body);calls.push({url,body});assert.equal(new URL(url).pathname,'/rest/v1/rpc/edge_supervisor_social_overview');
    await db.exec('set role service_role');let result;
    try{result=(await db.query('select edge_supervisor_social_overview($1,$2,$3) result',[body.p_token_hash,body.p_stage,body.p_group_id])).rows[0].result;}finally{await db.exec('reset role');}
    return new Response(JSON.stringify(result));
   }});
  const call=async(extra={},token='fixture')=>{
   calls.length=0;const response=await handler(new Request('https://fixture.test/api',{method:'POST',headers:{'Content-Type':'application/json',...(token?{'x-hawaya-session':token}:{})},body:JSON.stringify({action:'getSupervisorSocial',prefetch:true,stage:'متوسط',...extra})}));
   return{status:response.status,data:await response.json()};
  };
  await t.test('groups, avatars, likes and both feeds arrive in one read',async()=>{
   const {data,status}=await call();assert.equal(status,200);assert.equal(calls.length,1);assert.equal(calls[0].body.p_token_hash,hash('fixture'));
   assert.deepEqual(data.groups.map(g=>g.id),[uuid(1),uuid(2)]);assert.deepEqual(data.feeds[0].messages.map(m=>m.id),[uuid(10)]);
   assert.equal(data.feeds[0].messages[0].imageUrl,'https://example.test/avatar.jpg');assert.equal(data.feeds[0].messages[0].likes,2);
   assert.deepEqual(data.feeds[1].messages.map(m=>m.id),[uuid(11),uuid(12)]);assert.equal(data.stage,'middle');
  });
  await t.test('invalid, missing, expired and inactive sessions reveal no feeds',async()=>{
   for(const token of ['','wrong','expired','inactive']){const r=await call({},token);assert.equal(r.status,401);assert.equal(r.data.feeds,undefined);assert.equal(calls.length,token?1:0);}
  });
  await t.test('foreign, deleted and inactive groups cannot leak into a stage',async()=>{
   for(const groupId of [uuid(3),uuid(4),uuid(999)]){const {data}=await call({groupId});assert.equal(data.feeds.length,1);assert.equal(data.feeds[0].messages[0].id,uuid(10));}
   const {data}=await call({groupId:uuid(2)});assert.deepEqual(data.feeds[1].messages.map(m=>m.id),[uuid(15)]);
   const invalid=await call({groupId:"' or true --"});assert.equal(invalid.status,400);assert.equal(calls.length,0);
  });
  await t.test('disabled stages remain visible for supervisor moderation',async()=>{
   const {data}=await call({stage:'ثانوي'});assert.equal(data.enabled,false);assert.equal(data.feeds[0].messages[0].id,uuid(13));
  });
  await t.test('pinned order, deleted exclusion and newest-100 chat window are preserved',async()=>{
   await db.exec(`begin;
    insert into hawaya_social_messages(id,stage_category,channel,group_id,body,author_name,created_at) select ('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'middle',kind,case when kind='chat' then '${uuid(1)}'::uuid end,'fixture','اختبار','2026-10-18'::timestamptz+n*interval '1 minute' from generate_series(1,240) n cross join lateral(select case when n<=120 then 'tweets' else 'chat' end kind) k;
    update hawaya_social_messages set pinned_at='2026-10-19' where id='${uuid(10)}';
    update hawaya_social_messages set deleted_at=now() where id='20000000-0000-4000-8000-000000000120';`);
   try{const {data}=await call();const [tweets,chat]=data.feeds.map(f=>f.messages);assert.equal(tweets.length,100);assert.equal(chat.length,100);assert.equal(tweets[0].id,uuid(10));assert.equal(tweets[0].pinned,true);assert.ok(!tweets.some(m=>m.id.endsWith('000000000120')));assert.ok(chat.every((m,i)=>i===0||new Date(m.createdAt)>=new Date(chat[i-1].createdAt)));assert.equal(chat[0].id,'20000000-0000-4000-8000-000000000141');}finally{await db.exec('rollback');}
  });
  await t.test('browser roles cannot execute server RPC and revocation applies immediately',async()=>{
   for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>db.query('select edge_supervisor_social_overview($1,$2)',[hash('fixture'),'middle']),/permission denied/);await db.exec('reset role');}
   await db.exec("update app_private.api_sessions set expires_at=now()-interval '1 minute'");assert.equal((await call()).status,401);
  });
 }finally{await db.close();}
});
