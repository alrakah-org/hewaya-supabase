const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite'),{pgcrypto}=require('@electric-sql/pglite/contrib/pgcrypto');
const dir=__dirname+'/../supabase/migrations/';
const migration=fs.readFileSync(dir+fs.readdirSync(dir).find(n=>n.endsWith('_normalize_student_login_codes.sql')),'utf8');
test('legacy padded IDs authenticate without weakening exact-account selection',async t=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try{
  await db.exec(`create schema app_private;create schema extensions;create extension pgcrypto with schema extensions;create role anon;create role authenticated;create role service_role;
   create table students(id bigint primary key,student_code text unique,active boolean);create table app_private.student_credentials(student_id bigint primary key,password_hash text);
   insert into students values(1,'87',true),(2,'91',true),(3,'0091',true),(4,'88',true),(5,'0088',false),(6,'bad',true),(7,'missing',true);
   insert into app_private.student_credentials values(1,extensions.crypt('2468',extensions.gen_salt('bf',4))),(2,extensions.crypt('1122',extensions.gen_salt('bf',4))),(3,extensions.crypt('3344',extensions.gen_salt('bf',4))),(4,extensions.crypt('5566',extensions.gen_salt('bf',4))),(5,extensions.crypt('7788',extensions.gen_salt('bf',4))),(6,'invalid-unrelated-hash');`);
  await db.exec(migration);
  const verify=async(code,pin)=>(await db.query('select edge_student_verify($1,$2) id',[code,pin])).rows[0].id;
  await t.test('canonical, padded, Arabic digits and surrounding whitespace work',async()=>{
   for(const code of ['87','087','00087',' 087 ','٠٨٧','۰۸۷'])assert.equal(await verify(code,'2468'),1);
   assert.equal(await verify('٠٨٧','٢٤٦٨'),1);
  });
  await t.test('exact distinct padded account is preferred and never falls through on wrong PIN',async()=>{
   assert.equal(await verify('0091','3344'),3);assert.equal(await verify('0091','1122'),null);assert.equal(await verify('91','1122'),2);
  });
  await t.test('inactive exact account never falls through to another active account',async()=>{assert.equal(await verify('0088','5566'),null);assert.equal(await verify('0088','7788'),null);});
  await t.test('wrong PIN, missing credentials, empty input and SQL-like identifiers rejected',async()=>{
   for(const [code,pin]of [['087','9999'],['missing','2468'],['unknown','2468'],[null,'2468'],['87',null],["87' OR true --",'2468']])assert.equal(await verify(code,pin),null);
  });
  await t.test('browser roles cannot execute verification or read credentials; service verifies only',async()=>{
   for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>verify('087','2468'),/permission denied/);await db.exec('reset role');}
   await db.exec('set role service_role');assert.equal(await verify('087','2468'),1);await assert.rejects(()=>db.query('select * from app_private.student_credentials'),/permission denied/);await db.exec('reset role');
  });
 }finally{await db.close();}
});
