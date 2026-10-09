const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {stripTypeScriptTypes} = require('node:module');
const {webcrypto} = require('node:crypto');
const {test} = require('node:test');
const source=stripTypeScriptTypes(fs.readFileSync(process.env.HAWAYA_API_SOURCE || __dirname+'/../supabase/functions/hawaya-social/index.ts','utf8'));
const G1='10000000-0000-4000-8000-000000000001',G2='10000000-0000-4000-8000-000000000002';
const M1='20000000-0000-4000-8000-000000000001',M2='20000000-0000-4000-8000-000000000002',M3='20000000-0000-4000-8000-000000000003',M4='20000000-0000-4000-8000-000000000004';
function harness({enabled=true}={}){
 let handler;
 const tables={students:[{id:1,full_name:'طالب تجريبي',grade:'أول متوسط',active:true,photo_url:''}],group_memberships:[{student_id:1,group_id:G1,left_at:null}],groups:[{id:G1,name:'مجموعة أ',stage_category:'middle',active:true},{id:G2,name:'مجموعة ب',stage_category:'elementary_456',active:true}],tweet_stage_settings:[{stage_category:'middle',enabled}],hawaya_social_likes:[],hawaya_social_messages:[
 {id:M1,stage_category:'middle',channel:'tweets',group_id:null,deleted_at:null,body:'مرحلة الطالب',author_name:'طالب',author_student_id:1,created_at:'2026-10-05T14:00:00Z'},
 {id:M2,stage_category:'elementary_456',channel:'tweets',group_id:null,deleted_at:null,body:'مرحلة أخرى',created_at:'2026-10-05T14:01:00Z'},
 {id:M3,stage_category:'middle',channel:'chat',group_id:G1,deleted_at:null,body:'مجموعتي',created_at:'2026-10-05T14:00:00Z'},
 {id:M4,stage_category:'elementary_456',channel:'chat',group_id:G2,deleted_at:null,body:'مجموعة أخرى',created_at:'2026-10-05T14:00:00Z'}]};
 const writes=[],reads=[];
 const fetch=async(url,init={})=>{
  const u=new URL(url),p=u.pathname.replace('/rest/v1',''),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;
  reads.push({path:p,method,body});
  let result;
  if(p==='/rpc/edge_student_verify')result=body.p_code==='one'&&body.p_password==='synthetic'?1:0;
  else if(p==='/rpc/edge_supervisor_session')result=[{supervisor_id:'30000000-0000-4000-8000-000000000001',supervisor_name:'مشرف تجريبي'}];
  else{
   const name=p.slice(1);assert.ok(tables[name],name);
   if(name==='hawaya_social_messages'&&method==='GET'&&u.searchParams.get('select')?.includes('students(photo_url)'))throw Error('Ambiguous relationship between messages and students');
   const matches=row=>[...u.searchParams].every(([key,val])=>{
    if(['select','order','limit'].includes(key))return true;
    if(val==='is.null')return row[key]==null;
    if(val.startsWith('eq.'))return String(row[key])===val.slice(3);
    if(val.startsWith('in.('))return val.slice(4,-1).split(',').includes(String(row[key]));
    throw Error('Unhandled '+val);
   });
   if(method==='GET'){result=tables[name].filter(matches).map(x=>({...x}));if(u.searchParams.has('order'))result.sort((a,b)=>{if(u.searchParams.get('order').startsWith('pinned_at')){if(!!a.pinned_at!==!!b.pinned_at)return a.pinned_at?-1:1;const pin=String(b.pinned_at||'').localeCompare(String(a.pinned_at||''));if(pin)return pin;}return String(b.created_at).localeCompare(String(a.created_at));});}
   else{writes.push({name,method,body,url});
    if(method==='POST'){const duplicate=tables[name].find(x=>name==='hawaya_social_likes'?x.message_id===body.message_id&&x.student_id===body.student_id:x.id===body.id);if(!duplicate)tables[name].push({...body,deleted_at:null,created_at:'2026-10-05T15:00:00Z'});result=[body];}
    if(method==='PATCH'){result=tables[name].filter(matches);result.forEach(x=>Object.assign(x,body));}
    if(method==='DELETE'){tables[name]=tables[name].filter(x=>!matches(x));result=[];}
   }
  }
  return new Response(JSON.stringify(result),{status:200});
 };
 const ctx={Deno:{env:{get:n=>n==='SUPABASE_URL'?'https://example.test':'synthetic-key'},serve:f=>{handler=f;}},fetch,Headers,Response,Request,URL,TextEncoder,crypto:webcrypto,console,setTimeout};
 vm.runInNewContext(source,ctx);
 const call=async(action,extra={},supervisor=false)=>{
  const response=await handler(new Request('https://example.test/api',{method:'POST',headers:{'Content-Type':'application/json',...(supervisor?{'x-hawaya-session':'synthetic-session'}:{})},body:JSON.stringify({action,id:'one',password:'synthetic',...extra})}));
  return {status:response.status,data:await response.json()};
 };
 return {call,tables,writes,reads};
}
test('student stage is derived server-side and ignores tampered stage',async()=>{
 const h=harness(),{data}=await h.call('getStudentSocial',{stage:'elementary_456'});
 assert.equal(data.stage,'middle');assert.deepEqual(data.messages.map(x=>x.id),[M1]);
});
test('chat ignores another requested group and reads only current membership',async()=>{
 const h=harness(),{data}=await h.call('getStudentSocial',{channel:'chat',groupId:G2});
 assert.equal(data.groupName,'مجموعة أ');assert.deepEqual(data.messages.map(x=>x.id),[M3]);
});
test('wrong credentials cannot read or write',async()=>{
 const h=harness(),{data}=await h.call('postStudentSocial',{password:'wrong',text:'attempt',messageId:webcrypto.randomUUID()});
 assert.equal(data.success,false);assert.equal(h.writes.length,0);
});
test('disabled stage prevents publishing and hides feed',async()=>{
 const h=harness({enabled:false}),{data}=await h.call('postStudentSocial',{text:'attempt',messageId:webcrypto.randomUUID()});
 assert.equal(data.enabled,false);assert.deepEqual(data.messages,[]);assert.equal(h.writes.length,0);
});
test('post author and scope cannot be forged, repeated request does not duplicate',async()=>{
 const h=harness(),id=webcrypto.randomUUID(),payload={text:'إنجاز اليوم',messageId:id,stage:'secondary',name:'forged',author_supervisor_id:'fake'};
 await h.call('postStudentSocial',payload);await h.call('postStudentSocial',payload);
 const m=h.tables.hawaya_social_messages.find(m=>m.id===id);
 assert.equal(m.author_name,'طالب تجريبي');assert.equal(m.author_student_id,1);assert.equal(m.author_supervisor_id,null);assert.equal(m.stage_category,'middle');
 assert.equal(h.tables.hawaya_social_messages.filter(m=>m.id===id).length,1);
});
test('foreign-stage likes are denied',async()=>{
 const h=harness(),{data}=await h.call('setStudentSocialLike',{messageId:M2,liked:true});
 assert.equal(data.success,false);assert.equal(h.writes.length,0);
});
test('likes are idempotent and can be removed',async()=>{
 const h=harness();await h.call('setStudentSocialLike',{messageId:M1,liked:true});
 const {data}=await h.call('setStudentSocialLike',{messageId:M1,liked:true});
 assert.equal(data.messages[0].likes,1);assert.equal(data.messages[0].liked,true);
 await h.call('setStudentSocialLike',{messageId:M1,liked:false});assert.equal(h.tables.hawaya_social_likes.length,0);
});
test('student without a group cannot send chat',async()=>{
 const h=harness();h.tables.group_memberships=[];
 const {data}=await h.call('postStudentSocial',{channel:'chat',groupId:G2,text:'attempt',messageId:webcrypto.randomUUID()});
 assert.equal(data.success,false);assert.equal(h.writes.length,0);
});
test('supervisor actions require session and delete only selected scope',async()=>{
 const h=harness();assert.equal((await h.call('deleteSupervisorSocial',{stage:'middle',messageId:M1})).status,401);
 await h.call('deleteSupervisorSocial',{stage:'middle',messageId:M2},true);assert.equal(h.tables.hawaya_social_messages.find(m=>m.id===M2).deleted_at,null);
 await h.call('deleteSupervisorSocial',{stage:'middle',messageId:M1},true);assert.ok(h.tables.hawaya_social_messages.find(m=>m.id===M1).deleted_at);
});
test('supervisor setting persists and student respects it',async()=>{
 const h=harness();assert.equal((await h.call('setSocialStageEnabled',{stage:'middle',enabled:false},true)).data.success,true);
 assert.equal((await h.call('getStudentSocial')).data.enabled,false);
});
test('tweets newest first, chats chronological',async()=>{
 const h=harness();await h.call('postStudentSocial',{messageId:webcrypto.randomUUID(),text:'new'});
 assert.equal((await h.call('getStudentSocial')).data.messages[0].text,'new');
 await h.call('postStudentSocial',{channel:'chat',messageId:webcrypto.randomUUID(),text:'new chat'});
 const chat=(await h.call('getStudentSocial',{channel:'chat'})).data.messages;
 assert.equal(chat[0].id,M3);assert.equal(chat.at(-1).text,'new chat');
});

test('pin requires supervisor session',async()=>{
 const h=harness(),r=await h.call('setSupervisorSocialPin',{stage:'middle',messageId:M1,pinned:true});
 assert.equal(r.status,401);assert.equal(h.writes.length,0);
});
test('pinned tweet precedes newer tweets, unpin restores chronological feed',async()=>{
 const h=harness(),id=webcrypto.randomUUID();
 await h.call('postStudentSocial',{text:'newer tweet',messageId:id});
 let r=await h.call('setSupervisorSocialPin',{stage:'middle',messageId:M1,pinned:true},true);
 assert.equal(r.data.success,true);
 const student=(await h.call('getStudentSocial')).data.messages;
 assert.equal(student[0].id,M1);assert.equal(student[0].pinned,true);
 assert.equal(h.tables.hawaya_social_messages.find(m=>m.id===M1).pinned_by,'30000000-0000-4000-8000-000000000001');
 await h.call('setSupervisorSocialPin',{stage:'middle',messageId:M1,pinned:false},true);
 assert.equal((await h.call('getStudentSocial')).data.messages[0].id,id);
 assert.equal(h.tables.hawaya_social_messages.find(m=>m.id===M1).pinned_by,null);
});
test('pin cannot affect another stage or group chat',async()=>{
 const h=harness();
 assert.equal((await h.call('setSupervisorSocialPin',{stage:'middle',messageId:M2,pinned:true},true)).data.success,false);
 assert.equal((await h.call('setSupervisorSocialPin',{stage:'middle',channel:'chat',groupId:G1,messageId:M3,pinned:true},true)).data.success,false);
 assert.equal(h.tables.hawaya_social_messages.find(m=>m.id===M2).pinned_at,undefined);
 assert.equal(h.tables.hawaya_social_messages.find(m=>m.id===M3).pinned_at,undefined);
});
test('student cannot inject pin fields while posting',async()=>{
 const h=harness(),id=webcrypto.randomUUID();
 await h.call('postStudentSocial',{messageId:id,text:'ordinary',pinned:true,pinned_at:'2026-10-05',pinned_by:'forged'});
 const m=h.tables.hawaya_social_messages.find(m=>m.id===id);
 assert.equal(m.pinned_at,undefined);assert.equal(m.pinned_by,undefined);
});



test('prefetch authenticates once and returns only own stage and group',async()=>{
 const h=harness(),{data}=await h.call('getStudentSocial',{prefetch:true,stage:'secondary',groupId:G2});
 assert.deepEqual(data.channels.tweets.messages.map(x=>x.id),[M1]);
 assert.deepEqual(data.channels.chat.messages.map(x=>x.id),[M3]);
 assert.equal(data.channels.chat.groupId,G1);
 assert.equal(h.reads.filter(x=>x.path==='/rpc/edge_student_verify').length,1);
 assert.equal(h.reads.filter(x=>x.path==='/hawaya_social_likes').length,1);
 assert.equal(h.writes.length,0);
});
test('disabled prefetch gives both empty tabs without querying messages',async()=>{
 const h=harness({enabled:false}),{data}=await h.call('getStudentSocial',{prefetch:true});
 assert.equal(data.channels.tweets.enabled,false);assert.equal(data.channels.chat.enabled,false);
 assert.deepEqual(data.channels.tweets.messages,[]);assert.deepEqual(data.channels.chat.messages,[]);
 assert.equal(h.reads.filter(x=>x.path==='/hawaya_social_messages').length,0);
});
test('prefetch with no membership never reads other groups',async()=>{
 const h=harness();h.tables.group_memberships=[];
 const {data}=await h.call('getStudentSocial',{prefetch:true,channel:'chat',groupId:G2});
 assert.deepEqual(data.channels.chat.messages,[]);assert.equal(data.channels.chat.hasGroup,false);
 assert.deepEqual(data.channels.tweets.messages.map(x=>x.id),[M1]);
});
test('chat reads skip tweet like queries',async()=>{
 const h=harness();await h.call('getStudentSocial',{channel:'chat'});
 assert.equal(h.reads.filter(x=>x.path==='/hawaya_social_likes').length,0);
});
test('invalid credentials cannot prefetch either feed',async()=>{
 const h=harness(),{data}=await h.call('getStudentSocial',{prefetch:true,password:'wrong'});
 assert.equal(data.success,false);assert.equal(data.channels,undefined);assert.equal(h.reads.length,1);
});



test('supervisor overview requires a supervisor session',async()=>{
 const h=harness(),r=await h.call('getSupervisorSocial',{prefetch:true,stage:'middle'});
 assert.equal(r.status,401);assert.equal(h.reads.length,0);
});
test('supervisor overview reads only selected-stage groups with one session check',async()=>{
 const h=harness(),{data}=await h.call('getSupervisorSocial',{prefetch:true,stage:'middle'},true);
 assert.equal(data.success,true);assert.deepEqual(data.groups.map(g=>g.id),[G1]);
 assert.deepEqual(data.feeds[0].messages.map(m=>m.id),[M1]);assert.deepEqual(data.feeds[1].messages.map(m=>m.id),[M3]);
 assert.equal(h.reads.filter(r=>r.path==='/rpc/edge_supervisor_session').length,1);
 assert.equal(h.reads.filter(r=>r.path==='/students'||r.path==='/group_memberships').length,0);
});
test('overview does not read a requested foreign-stage group',async()=>{
 const h=harness(),{data}=await h.call('getSupervisorSocial',{prefetch:true,stage:'middle',groupId:G2},true);
 assert.equal(data.feeds.length,1);assert.equal(data.feeds[0].channel,'tweets');
 assert.equal(data.feeds[0].messages.some(m=>m.id===M4),false);
});
test('disabled stage retains supervisor moderation feed',async()=>{
 const h=harness({enabled:false}),{data}=await h.call('getSupervisorSocial',{prefetch:true,stage:'middle'},true);
 assert.equal(data.enabled,false);assert.deepEqual(data.feeds[0].messages.map(m=>m.id),[M1]);
});
