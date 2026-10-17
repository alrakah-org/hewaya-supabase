type Environment = { url: string; serviceKey: string; gatewayKey: string };
type PushSubscription = {endpoint:string;keys:{p256dh:string;auth:string}};
type PushOptions = {TTL:number;urgency:'normal';contentEncoding:'aes128gcm';topic:string;vapidDetails:{subject:string;publicKey:string;privateKey:string}};
type WebPush = { generateVAPIDKeys(): {publicKey:string;privateKey:string}; generateRequestDetails(subscription:PushSubscription,payload:string,options:PushOptions): {endpoint:string;headers:Record<string,string>;body:Uint8Array|null} };
const ORIGIN='https://alrakah-org.github.io';
const APP_ROOT=ORIGIN+'/hewaya-supabase/apps/';
export const VERSION='hawaya-web-push-20261015';
const headers={'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-hawaya-session,x-hawaya-push-worker','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers});
const hex=/^[a-f0-9]{64}$/;
function equalSecret(a:string,b:string){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
async function sha256(value:string){const data=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(data),b=>b.toString(16).padStart(2,'0')).join('');}

export function validEndpoint(value:unknown):value is string {
 if(typeof value!=='string'||value.length>2048)return false;
 try{
  const url=new URL(value),host=url.hostname.toLowerCase();
  return url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&(!url.port||url.port==='443')&&url.pathname.length>1&&(
   host==='fcm.googleapis.com'||host==='web.push.apple.com'||host==='updates.push.services.mozilla.com'||
   /^[a-z0-9-]+\.push\.services\.mozilla\.com$/.test(host)||/^[a-z0-9-]+\.notify\.windows\.com$/.test(host)
  );
 }catch{return false;}
}
function keyLength(value:unknown,length:number){
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]+={0,2}$/.test(value))return false;
 try{return atob(value.replace(/-/g,'+').replace(/_/g,'/')).length===length;}catch{return false;}
}
export function validSubscription(subscription:any){return subscription&&validEndpoint(subscription.endpoint)&&keyLength(subscription.keys?.p256dh,65)&&keyLength(subscription.keys?.auth,16);}

export function notificationPayload(job:any){
 const supervisor=job.role==='supervisor';
 const url=new URL(APP_ROOT+(supervisor?'supervisor/':'student/'));
 url.searchParams.set('notify',job.kind);
 if(supervisor&&job.stage)url.searchParams.set('stage',job.stage);
 if(supervisor&&job.kind==='chat'&&job.groupId)url.searchParams.set('group',job.groupId);
 const labels:Record<string,string>={elementary_456:'الابتدائي',middle:'المتوسط',secondary:'الثانوي'};
 const title=job.kind==='points'?'تم تعديل نقاطك':job.kind==='chat'?(supervisor?'رسالة جديدة في مجموعة':'رسالة جديدة في مجموعتك'):(supervisor?'تغريدة جديدة':'تغريدة جديدة في مرحلتك');
 return {title,body:job.kind==='points'?'افتح هواية للاطلاع على نقاطك.':supervisor?((labels[job.stage]||'هواية')+' — افتح التطبيق لقراءة المشاركة.'):'افتح هواية لقراءة المشاركة الجديدة.',url:url.href,binding:job.subscriptionId,tag:'hawaya-'+job.id};
}

export function createPushHandler(env:Environment,webpush:WebPush,fetcher:typeof fetch=fetch){
 async function rpc(name:string,body:unknown={}){
  const response=await fetcher(env.url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:env.serviceKey,Authorization:'Bearer '+env.serviceKey,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error('Push database unavailable');
  return response.json();
 }
 async function configuration(){
  let config=await rpc('edge_push_config');
  if(!config?.vapid_public){
   const keys=webpush.generateVAPIDKeys();
   config=await rpc('edge_push_initialize',{p_public:keys.publicKey,p_private:keys.privateKey,p_gateway:env.gatewayKey});
  }
  return config;
 }
 async function register(req:Request,body:any){
  if(!validSubscription(body.subscription)||!hex.test(String(body.deviceToken||'')))return json({success:false,error:'بيانات اشتراك الإشعارات غير صالحة'},400);
  let studentId:number|null=null,supervisorId:string|null=null,sessionHash:string|null=null;
  if(body.role==='student'){
   if(typeof body.id!=='string'||typeof body.password!=='string'||body.id.length>100||body.password.length>200)return json({success:false,error:'سجّل الدخول مجددًا'},401);
   studentId=await rpc('edge_student_verify',{p_code:body.id,p_password:body.password});
   if(!studentId)return json({success:false,error:'سجّل الدخول مجددًا'},401);
  }else if(body.role==='supervisor'){
   const token=req.headers.get('x-hawaya-session')||'';
   if(!token||token.length>500)return json({success:false,error:'سجّل الدخول مجددًا'},401);
   sessionHash=await sha256(token);
   const supervisors=await rpc('edge_supervisor_session',{p_token_hash:sessionHash});
   supervisorId=supervisors?.[0]?.supervisor_id||null;
   if(!supervisorId)return json({success:false,error:'سجّل الدخول مجددًا'},401);
  }else return json({success:false,error:'نوع الحساب غير صالح'},400);
  const binding=await rpc('edge_push_register',{p_role:body.role,p_student:studentId,p_supervisor:supervisorId,p_session_hash:sessionHash,p_endpoint:body.subscription.endpoint,p_keys:{p256dh:body.subscription.keys.p256dh,auth:body.subscription.keys.auth},p_device_hash:await sha256(body.deviceToken)});
  return json({success:true,binding});
 }
 async function dispatch(req:Request){
  const worker=req.headers.get('x-hawaya-push-worker')||'';
  if(!hex.test(worker))return json({success:false},401);
  const config=await rpc('edge_push_config');
  if(!config||!equalSecret(worker,config.worker_secret))return json({success:false},401);
  if(!config.enabled||!config.vapid_public)return json({success:true,processed:0});
  const jobs=await rpc('edge_push_claim',{p_limit:30});
  let cursor=0,sent=0,expired=0,retry=0;
  await Promise.all(Array.from({length:Math.min(5,jobs.length)},async()=>{
   while(cursor<jobs.length){
    const job=jobs[cursor++];let result='retry';
    try{
     if(!validSubscription(job)){result='expired';}
     else{
      const details=webpush.generateRequestDetails({endpoint:job.endpoint,keys:job.keys},JSON.stringify(notificationPayload(job)),{
       TTL:3600,urgency:'normal',contentEncoding:'aes128gcm',topic:String(job.id).replace(/-/g,'').slice(0,32),
       vapidDetails:{subject:ORIGIN+'/hewaya-supabase/',publicKey:config.vapid_public,privateKey:config.vapid_private}
      });
      const response=await fetcher(job.endpoint,{method:'POST',headers:details.headers,body:details.body as BodyInit,redirect:'manual',signal:AbortSignal.timeout(8000)});
      result=response.ok?'sent':[404,410].includes(response.status)?'expired':'retry';
     }
    }catch{result='retry';}
    // No endpoint, student detail, credential, or message text goes into logs.
    await rpc('edge_push_finish',{p_id:job.id,p_revision:job.revision,p_result:result});
    if(result==='sent')sent++;else if(result==='expired')expired++;else retry++;
   }
  }));
  return json({success:true,processed:jobs.length,sent,expired,retry});
 }
 return async(req:Request)=>{
  if(req.headers.get('Origin')&&req.headers.get('Origin')!==ORIGIN)return json({success:false},403);
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(req.method!=='POST')return json({success:false},405);
  try{
   const text=await req.text();if(text.length>8192)return json({success:false},413);
   let body:any;try{body=JSON.parse(text);}catch{return json({success:false},400);}
   if(!body||typeof body!=='object'||Array.isArray(body))return json({success:false},400);
   if(body.action==='getPushVersion')return json({success:true,version:VERSION});
   if(body.action==='getPushConfig'){const c=await configuration();return json({success:true,publicKey:c.vapid_public});}
   if(body.action==='subscribe')return await register(req,body);
   if(body.action==='unsubscribe'){
    if(!validEndpoint(body.endpoint)||!hex.test(String(body.deviceToken||'')))return json({success:false},400);
    await rpc('edge_push_unregister',{p_endpoint:body.endpoint,p_device_hash:await sha256(body.deviceToken)});
    return json({success:true});
   }
   if(body.action==='dispatch')return await dispatch(req);
   return json({success:false,error:'الإجراء غير متاح'},400);
  }catch{return json({success:false,error:'تعذر إعداد الإشعارات الآن. حاول مرة أخرى.'},503);}
 };
}
