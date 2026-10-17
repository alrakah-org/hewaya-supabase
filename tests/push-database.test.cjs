// In-memory Postgres only. All identities, credentials and endpoints are fixtures.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const {pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const migration=fs.readFileSync(__dirname+'/../supabase/migrations/'+fs.readdirSync(__dirname+'/../supabase/migrations').find(n=>n.endsWith('_add_hawaya_web_push.sql')),'utf8');
const uuid=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');

test('push delivery routing, authorization and durable queue',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});
 const query=async(sql,args=[])=>(await db.query(sql,args)).rows;
 try{
  await db.exec(`
   create schema app_private; create schema extensions; create extension pgcrypto with schema extensions;
   create role anon; create role authenticated; create role service_role bypassrls;
   create table students(id bigint primary key,grade text,stage_category text,active boolean);
   create table app_private.supervisors(id uuid primary key,active boolean);
   create table app_private.api_sessions(supervisor_id uuid,token_hash text,expires_at timestamptz);
   create table app_private.student_credentials(student_id bigint primary key,password_hash text);
   create table groups(id uuid primary key,stage_category text,active boolean);
   create table group_memberships(student_id bigint,group_id uuid,left_at date);
   create table tweet_stage_settings(stage_category text primary key,enabled boolean);
   create table hawaya_social_messages(id uuid primary key default gen_random_uuid(),stage_category text,channel text,group_id uuid,author_student_id bigint,author_supervisor_id uuid,deleted_at timestamptz,body text,pinned_at timestamptz);
   create table point_awards(id bigint generated always as identity,student_id bigint,total_points integer,note text);
   create table point_transactions(id bigint generated always as identity,student_id bigint,amount integer);
   create table attendance(id bigint generated always as identity,student_id bigint,points integer);
   create function edge_supervisor_session(p_token_hash text) returns table(supervisor_id uuid) language sql security definer set search_path=public,app_private,pg_temp as $$
    select s.id from app_private.supervisors s join app_private.api_sessions x on x.supervisor_id=s.id where s.active and x.token_hash=p_token_hash and x.expires_at>now();
   $$;
   revoke all on function edge_supervisor_session(text) from public; grant execute on function edge_supervisor_session(text) to service_role;
   grant select,insert,update,delete on all tables in schema public to service_role;
   grant usage,select on all sequences in schema public to service_role;
   create schema net; create schema cron;
   create table public.test_wakes(id bigint generated always as identity,body jsonb);
   grant usage on schema net to service_role;
   create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer) returns bigint language plpgsql security definer as $$declare result bigint;begin insert into public.test_wakes(body) values(body) returning id into result;return result;end;$$;
   create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
   insert into students values (1,'أول متوسط','middle',true),(2,'ثاني متوسط','middle',true),(3,'ثالث متوسط','middle',true),(4,'أول ثانوي','secondary',true),(5,'خامس','elementary_456',true),(6,'متوسط','middle',false),(7,'متوسط','secondary',true);
   insert into groups values ('${uuid(1)}','middle',true),('${uuid(2)}','middle',true),('${uuid(3)}','secondary',true);
   insert into group_memberships values(1,'${uuid(1)}',null),(2,'${uuid(1)}',null),(3,'${uuid(2)}',null),(4,'${uuid(3)}',null),(7,'${uuid(1)}',null);
   insert into tweet_stage_settings values('middle',true),('secondary',true),('elementary_456',true);
   insert into app_private.supervisors values('${uuid(10)}',true),('${uuid(11)}',true),('${uuid(12)}',true);
   insert into app_private.api_sessions values('${uuid(10)}','session-10',now()+interval '1 day'),('${uuid(11)}','session-11',now()+interval '1 day'),('${uuid(12)}','expired-session',now()-interval '1 day');
   insert into app_private.student_credentials values(1,'synthetic-old-hash');
  `);
  await db.exec(migration.replace(/^create extension if not exists pg_(?:net|cron).*;$/gm,''));
  const register=async({student=null,supervisor=null,session=null,endpoint='https://fcm.googleapis.com/fcm/send/'+(student||supervisor),device='fixture-device'}={})=>(await query('select edge_push_register($1,$2,$3,$4,$5,$6,$7) id',[student?'student':'supervisor',student,supervisor,session,endpoint,JSON.stringify({p256dh:'fixture',auth:'fixture'}),device]))[0].id;
  const subs={};for(let i=1;i<=7;i++)subs[i]=await register({student:i});
  for(const i of [10,11,12])subs[i]=await register({supervisor:uuid(i),session:i===12?'expired-session':'session-'+i});
  const recipients=async()=> (await query('select coalesce(s.student_id::text,s.supervisor_id::text) owner,q.kind from app_private.push_queue q join app_private.push_subscriptions s on s.id=q.subscription_id order by owner')).map(r=>r.owner+':'+r.kind);
  const expected=(ids,kind)=>ids.map(i=>(i>=10?uuid(i):String(i))+':'+kind).sort();
  const post=async({stage='middle',kind='tweets',group=null,student=1,supervisor=null}={})=>(await query('insert into hawaya_social_messages(stage_category,channel,group_id,author_student_id,author_supervisor_id) values($1,$2,$3,$4,$5) returning id',[stage,kind,group,student,supervisor]))[0].id;
  const claim=async()=>(await query('select edge_push_claim(100) jobs'))[0].jobs;
  const finish=async(job,result='sent')=>query('select edge_push_finish($1,$2,$3)',[job.id,job.revision,result]);
  const isolated=async(name,fn)=>t.test(name,async()=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback');}});
  await isolated('public tweets stay in student stage, exclude sender, reach every active supervisor',async()=>{
   await post();assert.deepEqual(await recipients(),expected([2,3,7,10,11],'tweets'));
   const jobs=await claim();assert.equal(jobs.length,5);assert.ok(jobs.every(j=>j.stage==='middle'));
  });
  await isolated('group chat reaches only current group plus all supervisors',async()=>{
   await post({kind:'chat',group:uuid(1)});assert.deepEqual(await recipients(),expected([2,7,10,11],'chat'));
  });
  await isolated('supervisor sender excluded; other supervisors receive other-stage tweets',async()=>{
   await post({stage:'secondary',student:null,supervisor:uuid(10)});assert.deepEqual(await recipients(),expected([4,11],'tweets'));
  });
  await isolated('disabled student stage does not suppress supervisor notifications',async()=>{
   await db.exec("update tweet_stage_settings set enabled=false where stage_category='middle'");await post();assert.deepEqual(await recipients(),expected([10,11],'tweets'));
  });
  await isolated('every new message is queued separately; editing and pinning do not notify',async()=>{
   const id=await post();await post();assert.equal((await recipients()).length,10);
   await query('update hawaya_social_messages set body=$1,pinned_at=now() where id=$2',['edited',id]);assert.equal((await recipients()).length,10);
  });
  await isolated('permissions are checked again at delivery after membership or account changes',async()=>{
   await post({kind:'chat',group:uuid(1)});
   await db.exec(`update group_memberships set left_at=current_date where student_id=2;update students set active=false where id=7;update app_private.api_sessions set expires_at=now()-interval '1 minute' where supervisor_id='${uuid(11)}';`);
   const jobs=await claim();assert.equal(jobs.length,1);assert.equal(jobs[0].subscriptionId,subs[10]);
  });
  await isolated('deleted posts and inactive groups are discarded before delivery',async()=>{
   const id=await post();await query('update hawaya_social_messages set deleted_at=now() where id=$1',[id]);assert.equal((await claim()).length,0);
   await post({kind:'chat',group:uuid(1)});await query('update groups set active=false where id=$1',[uuid(1)]);assert.equal((await claim()).length,0);
  });
  for(const [table,column]of [['point_awards','total_points'],['point_transactions','amount'],['attendance','points']])await isolated(table+' notifies owner on insert/change/delete, never other students or supervisors',async()=>{
   await db.exec(`insert into ${table}(student_id,${column}) values(1,10)`);assert.deepEqual(await recipients(),['1:points']);
   let job=(await claim())[0];await finish(job);assert.equal((await recipients()).length,0);
   await db.exec(`update ${table} set ${column}=10`);assert.equal((await recipients()).length,0);
   await db.exec(`update ${table} set ${column}=20`);assert.deepEqual(await recipients(),['1:points']);
   await finish((await claim())[0]);await db.exec(`delete from ${table}`);assert.deepEqual(await recipients(),['1:points']);
  });
  await isolated('point ownership transfer notifies both affected students; zero rows do not notify',async()=>{
   await db.exec('insert into point_awards(student_id,total_points) values(1,0)');assert.deepEqual(await recipients(),[]);
   await db.exec('update point_awards set total_points=10');await finish((await claim())[0]);
   await db.exec('update point_awards set student_id=2');assert.deepEqual(await recipients(),['1:points','2:points']);
  });
  await isolated('new points survive old delivery acknowledgement; leases prevent double claims',async()=>{
   await db.exec('insert into attendance(student_id,points) values(1,10)');const job=(await claim())[0];assert.equal((await claim()).length,0);
   await db.exec('update attendance set points=20');await finish(job);const newer=(await claim())[0];assert.equal(newer.revision,job.revision+1);
   await finish(newer);assert.deepEqual(await recipients(),[]);
  });
  await isolated('retry backs off; an in-flight last attempt is preserved; expired endpoints are removed',async()=>{
   await db.exec('insert into attendance(student_id,points) values(1,10)');let job=(await claim())[0];await finish(job,'retry');assert.equal((await claim()).length,0);
   await db.exec("update app_private.push_queue set available_at=now(),attempts=5");job=(await claim())[0];assert.ok(job);assert.equal((await claim()).length,0);assert.equal((await recipients()).length,1);
   await finish(job,'expired');assert.deepEqual(await recipients(),[]);assert.equal((await query('select id from app_private.push_subscriptions where id=$1',[subs[1]])).length,0);
  });
  await isolated('endpoint ownership requires device capability; account switch resets binding and queue',async()=>{
   assert.equal(await register({student:1}),subs[1]);
   await db.exec('savepoint wrong_device');await assert.rejects(()=>register({student:1,device:'wrong'}),/Device subscription mismatch/);await db.exec('rollback to savepoint wrong_device');
   await db.exec('insert into attendance(student_id,points) values(1,10)');
   const replacement=await register({student:2,endpoint:'https://fcm.googleapis.com/fcm/send/1'});assert.notEqual(replacement,subs[1]);assert.deepEqual(await recipients(),[]);
   await query('select edge_push_unregister($1,$2)',['https://fcm.googleapis.com/fcm/send/1','wrong']);assert.equal((await query('select id from app_private.push_subscriptions where id=$1',[replacement])).length,1);
   await query('select edge_push_unregister($1,$2)',['https://fcm.googleapis.com/fcm/send/1','fixture-device']);assert.equal((await query('select id from app_private.push_subscriptions where id=$1',[replacement])).length,0);
  });
  await isolated('password reset revokes subscriptions and queued messages',async()=>{
   await db.exec("insert into attendance(student_id,points) values(1,10);update app_private.student_credentials set password_hash='synthetic-new-hash' where student_id=1");
   assert.deepEqual(await recipients(),[]);assert.equal((await query('select id from app_private.push_subscriptions where student_id=1')).length,0);
  });
  await isolated('VAPID initialization preserves existing keys; service writes trigger async wake',async()=>{
   await query('select edge_push_initialize($1,$2,$3)',['a'.repeat(87),'b'.repeat(43),'gateway-fixture-'.repeat(3)]);
   await query('select edge_push_initialize($1,$2,$3)',['c'.repeat(87),'d'.repeat(43),'gateway-fixture-'.repeat(3)]);
   assert.equal((await query('select edge_push_config() config'))[0].config.vapid_public,'a'.repeat(87));
   await db.exec('set local role service_role');await post();assert.equal((await claim()).length,5);await db.exec('reset role');
   assert.equal((await query('select count(*)::int n from test_wakes'))[0].n,1);
  });
  await isolated('browser roles cannot read push data or execute any push RPC',async()=>{
   for(const role of ['anon','authenticated']){
    const checks=await query("select p.proname,has_function_privilege($1,p.oid,'EXECUTE') allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'edge_push_%'",[role]);assert.ok(checks.length>=6);assert.ok(checks.every(c=>!c.allowed));
    for(const table of ['push_config','push_subscriptions','push_queue'])assert.equal((await query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') allowed",[role,'app_private.'+table]))[0].allowed,false);
   }
   assert.ok((await query("select prosecdef from pg_proc where proname like 'edge_push_%'")).every(f=>f.prosecdef===false));
  });
 }finally{await db.close();}
});
