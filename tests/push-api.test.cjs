const {test}=require('node:test'),assert=require('node:assert/strict'),{createECDH,randomBytes,createHash}=require('node:crypto');
const webpush=require('web-push');
const {createPushHandler,validEndpoint,notificationPayload}=require('../supabase/functions/hawaya-push/core.ts');
const device='a'.repeat(64),worker='b'.repeat(64),keys=webpush.generateVAPIDKeys();
const dh=createECDH('prime256v1');dh.generateKeys();
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/fixture',keys:{p256dh:dh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
function harness({student=12,supervisors=[{supervisor_id:'fixture-supervisor'}],jobs=[],statuses=[],initial=true,dbError=false}={}){
 const calls=[],sends=[];let config={enabled:true,worker_secret:worker,vapid_public:initial?keys.publicKey:null,vapid_private:initial?keys.privateKey:null};
 const fetcher=async(url,options)=>{
  if(url.startsWith('https://fixture.supabase.co/rest/v1/rpc/')){
   const name=url.split('/').pop(),body=JSON.parse(options.body);calls.push({name,body,headers:options.headers});
   if(dbError)return new Response('private database error',{status:500});
   const results={edge_push_config:()=>config,edge_push_initialize:()=>{config={...config,vapid_public:body.p_public,vapid_private:body.p_private};return config;},edge_student_verify:()=>student,edge_supervisor_session:()=>supervisors,edge_push_register:()=>'fixture-binding',edge_push_unregister:()=>null,edge_push_claim:()=>jobs,edge_push_finish:()=>null};
   assert.ok(results[name],name);return Response.json(results[name]());
  }
  sends.push({url,options});const status=statuses.shift()||201;if(status==='timeout')throw new Error('network timeout');return new Response('',{status});
 };
 const handler=createPushHandler({url:'https://fixture.supabase.co',serviceKey:'synthetic-service-key',gatewayKey:'synthetic-gateway-key'},webpush,fetcher);
 const request=(body,headers={},method='POST')=>handler(new Request('https://fixture.supabase.co/functions/v1/hawaya-push',{method,headers:{Origin:'https://alrakah-org.github.io',...headers},...(method!=='GET'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})}));
 return{calls,sends,request};
}
test('student subscription authenticates and ignores client-supplied identities and scope',async()=>{
 const h=harness(),r=await h.request({action:'subscribe',role:'student',id:'student-code',password:'synthetic-password',subscription,deviceToken:device,studentId:999,stage:'secondary',groupId:'other'});assert.equal(r.status,200);
 assert.deepEqual(await r.json(),{success:true,binding:'fixture-binding'});
 const write=h.calls.find(c=>c.name==='edge_push_register').body;assert.equal(write.p_student,12);assert.equal(write.p_supervisor,null);assert.equal(write.p_stage,undefined);assert.notEqual(write.p_device_hash,device);
 assert.ok(h.calls.every(c=>c.headers.Authorization==='Bearer synthetic-service-key'));
});
test('invalid student, missing or expired supervisor session never register',async()=>{
 for(const [body,options,headers]of [
  [{role:'student',id:'x',password:'wrong'}, {student:null},{}],
  [{role:'supervisor'},{},{}],
  [{role:'supervisor'},{supervisors:[]},{'x-hawaya-session':'expired'}]
 ]){const h=harness(options),r=await h.request({action:'subscribe',subscription,deviceToken:device,...body},headers);assert.equal(r.status,401);assert.ok(!h.calls.some(c=>c.name==='edge_push_register'));}
});
test('supervisor identity comes from verified session, only its hash enters storage',async()=>{
 const h=harness(),r=await h.request({action:'subscribe',role:'supervisor',subscription,deviceToken:device,supervisorId:'forged'},{'x-hawaya-session':'fixture-session'});assert.equal(r.status,200);
 const write=h.calls.find(c=>c.name==='edge_push_register').body;assert.equal(write.p_student,null);assert.equal(write.p_supervisor,'fixture-supervisor');assert.equal(write.p_session_hash,createHash('sha256').update('fixture-session').digest('hex'));
});
test('subscription endpoint restrictions block SSRF, redirects, credentials and malformed keys',async()=>{
 for(const endpoint of ['http://fcm.googleapis.com/a','https://127.0.0.1/a','https://example.org/a','https://fcm.googleapis.com.evil.test/a','https://user:password@fcm.googleapis.com/a','https://fcm.googleapis.com:444/a','https://web.push.apple.com/a#x']){
  assert.equal(validEndpoint(endpoint),false);const h=harness(),r=await h.request({action:'subscribe',role:'student',id:'x',password:'p',subscription:{...subscription,endpoint},deviceToken:device});assert.equal(r.status,400);assert.equal(h.calls.length,0);
 }
 for(const endpoint of ['https://web.push.apple.com/Qfixture','https://updates.push.services.mozilla.com/wpush/v2/fixture','https://wns2-par02p.notify.windows.com/w/?token=fixture'])assert.equal(validEndpoint(endpoint),true);
 const h=harness();assert.equal((await h.request({action:'subscribe',subscription:{...subscription,keys:{p256dh:'bad',auth:'bad'}},deviceToken:device})).status,400);
});
test('public configuration returns only one persisted VAPID public key',async()=>{
 const h=harness({initial:false});const r=await h.request({action:'getPushConfig'});assert.equal(r.status,200);const body=await r.json();assert.deepEqual(Object.keys(body).sort(),['publicKey','success']);assert.equal(body.publicKey.length,87);
 await h.request({action:'getPushConfig'});assert.equal(h.calls.filter(c=>c.name==='edge_push_initialize').length,1);
});
test('dispatch requires private worker secret, even with a gateway JWT',async()=>{
 for(const secret of ['', 'c'.repeat(64)]){const h=harness();assert.equal((await h.request({action:'dispatch'},{'x-hawaya-push-worker':secret})).status,401);assert.ok(!h.calls.some(c=>c.name==='edge_push_claim'));}
});
test('dispatch really encrypts payload; successful, expired and retryable providers settle separately',async()=>{
 const jobs=[201,410,429,'timeout'].map((_,i)=>({...subscription,id:'10000000-0000-4000-8000-'+String(i).padStart(12,'0'),revision:1,role:'student',kind:'chat',subscriptionId:'binding-'+i,stage:'middle'}));
 const h=harness({jobs,statuses:[201,410,429,'timeout']});const r=await h.request({action:'dispatch'},{'x-hawaya-push-worker':worker});assert.equal(r.status,200);assert.deepEqual(await r.json(),{success:true,processed:4,sent:1,expired:1,retry:2});
 assert.equal(h.sends.length,4);for(const send of h.sends){assert.equal(send.options.redirect,'manual');assert.match(send.options.headers.Authorization,/^vapid /);assert.equal(send.options.headers['Content-Encoding'],'aes128gcm');assert.ok(send.options.body.length>100);assert.equal(Buffer.from(send.options.body).includes(Buffer.from('binding-')),false);}
 assert.deepEqual(h.calls.filter(c=>c.name==='edge_push_finish').map(c=>c.body.p_result).sort(),['expired','retry','retry','sent']);
});
test('unsubscribe uses hashed device capability and remains possible after session expiry',async()=>{
 const h=harness();assert.equal((await h.request({action:'unsubscribe',endpoint:subscription.endpoint,deviceToken:device})).status,200);assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'edge_push_unregister');assert.notEqual(h.calls[0].body.p_device_hash,device);
});
test('payload links route by role and contain no private message text or student identity',()=>{
 for(const kind of ['points','tweets','chat'])for(const role of ['student','supervisor']){
  const p=notificationPayload({kind,role,subscriptionId:'opaque-binding',id:'job',stage:'secondary',groupId:'group',body:'secret-message',studentId:45});const url=new URL(p.url);
  assert.equal(url.searchParams.get('notify'),kind);assert.match(url.pathname,new RegExp('/'+role+'/$'));assert.equal(url.searchParams.get('stage'),role==='supervisor'?'secondary':null);assert.equal(url.searchParams.get('group'),role==='supervisor'&&kind==='chat'?'group':null);assert.equal(JSON.stringify(p).includes('secret-message'),false);
 }
});
test('bad origins, methods, malformed or oversized bodies rejected and internal errors sanitized',async()=>{
 const h=harness();assert.equal((await h.request({action:'getPushConfig'},{Origin:'https://evil.example'})).status,403);assert.equal((await h.request({}, {},'GET')).status,405);assert.equal((await h.request('{')).status,400);assert.equal((await h.request('x'.repeat(8193))).status,413);
 const failed=await harness({dbError:true}).request({action:'getPushConfig'});assert.equal(failed.status,503);assert.equal((await failed.text()).includes('private database error'),false);
});
