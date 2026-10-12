// Uses only an isolated, in-memory Postgres database and synthetic credentials.
// Dependencies: @electric-sql/pglite@0.5.8 (including contrib/pgcrypto).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite');
const {pgcrypto}=require(process.env.PGCRYPTO_PATH||'@electric-sql/pglite/contrib/pgcrypto');
const migration=fs.readFileSync(__dirname+'/../supabase/migrations/20261011145500_scope_student_password_verification.sql','utf8');

test('student verification is scoped, correct and server-only',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try {
  await db.exec(`
    create schema app_private; create schema extensions;
    create extension pgcrypto with schema extensions;
    create role anon; create role authenticated; create role service_role;
    create table public.students(id bigint primary key,student_code text unique,active boolean);
    create table app_private.student_credentials(student_id bigint primary key,password_hash text);
    insert into public.students values (1,'first',true),(2,'wanted',true),(3,'inactive',false),(4,'missing-hash',true),(5,'missing-credential',true);
    insert into app_private.student_credentials values
      (1,'invalid-salt-must-never-be-checked-for-another-student'),
      (2,extensions.crypt('fixture-password',extensions.gen_salt('bf',4))),
      (3,extensions.crypt('fixture-password',extensions.gen_salt('bf',4))),
      (4,null);
  `);
  await db.exec(migration);
  const verify=async(code,password)=>(await db.query('select public.edge_student_verify($1,$2) as id',[code,password])).rows[0].id;
  await t.test('valid password works despite an unrelated invalid credential',async()=>{
   assert.equal(await verify('wanted','fixture-password'),2);
  });
  await t.test('wrong password is rejected without scanning other credentials',async()=>{
   assert.equal(await verify('wanted','wrong-fixture-password'),null);
  });
  await t.test('unknown, inactive and missing-credential accounts are rejected',async()=>{
   for(const code of ['unknown','inactive','missing-hash','missing-credential']) assert.equal(await verify(code,'fixture-password'),null);
  });
  await t.test('null inputs and SQL-looking values cannot authenticate',async()=>{
   assert.equal(await verify('wanted',null),null);
   assert.equal(await verify(null,'fixture-password'),null);
   assert.equal(await verify("wanted' OR true --",'fixture-password'),null);
  });
  await t.test('crypt is evaluated only after materializing the candidate',async()=>{
   const body=migration.match(/as \$\$([\s\S]+?)\$\$/)[1];
   const plan=(await db.query('explain (format json) '+body.replace(/p_code/g,"'wanted'").replace(/p_password/g,"'wrong-fixture-password'"))).rows[0]['QUERY PLAN'][0].Plan;
   assert.equal(plan['Node Type'],'CTE Scan');
   assert.match(plan.Filter,/crypt/);
   assert.doesNotMatch(JSON.stringify(plan.Plans),/crypt/);
  });
  await t.test('client roles cannot execute verification',async()=>{
   for(const role of ['anon','authenticated']){
    await db.exec('set role '+role);
    await assert.rejects(()=>verify('wanted','fixture-password'),/permission denied for function edge_student_verify/);
    await db.exec('reset role');
   }
  });
  await t.test('service role can verify but cannot read credential hashes',async()=>{
   await db.exec('set role service_role');
   assert.equal(await verify('wanted','fixture-password'),2);
   await assert.rejects(()=>db.query('select * from app_private.student_credentials'),/permission denied/);
   await db.exec('reset role');
  });
  await t.test('reapplying migration preserves results and restrictions',async()=>{
   await db.exec(migration);
   assert.equal(await verify('wanted','fixture-password'),2);
   const grants=(await db.query("select has_function_privilege('anon','public.edge_student_verify(text,text)','execute') as anon,has_function_privilege('authenticated','public.edge_student_verify(text,text)','execute') as authenticated,has_function_privilege('service_role','public.edge_student_verify(text,text)','execute') as service")).rows[0];
   assert.deepEqual(grants,{anon:false,authenticated:false,service:true});
  });
 } finally {await db.close();}
});
