declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Response | Promise<Response>): void };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REST = `${SUPABASE_URL}/rest/v1`;
const API_VERSION = 'social-live-20261005';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hawaya-session',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
}

async function db(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('apikey', SERVICE_KEY);
  headers.set('Authorization', `Bearer ${SERVICE_KEY}`);
  headers.set('Content-Type', 'application/json');
  if (!headers.has('Prefer')) headers.set('Prefer', 'return=representation');

  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${REST}${path}`, { ...init, headers });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
    if (res.ok) return body;

    lastError = body?.message || body?.error || text || `DB ${res.status}`;
    const retryable = res.status >= 500 || res.status === 401 || String(lastError).includes('JWT issued at future');
    if (!retryable || attempt === 2) throw new Error(lastError);
    await new Promise((resolve) => setTimeout(resolve, 180 * (attempt + 1)));
  }
  throw new Error(lastError || 'Database request failed');
}

async function rpc(name: string, payload: Record<string, unknown>) {
  return db(`/rpc/${name}`, { method: 'POST', body: JSON.stringify(payload) });
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function stageCategory(stage = '') {
  if (stage.includes('متوسط')) return 'middle';
  if (stage.includes('ثانوي')) return 'secondary';
  return 'elementary_456';
}

function categoryLabel(category = '') {
  if (category === 'middle' || category === 'متوسط') return 'متوسط';
  if (category === 'secondary' || category === 'ثانوي') return 'ثانوي';
  return 'رابع+خامس+سادس';
}

function riyadhParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((a: Record<string,string>, p) => (a[p.type] = p.value, a), {});
  const map: Record<string,number> = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return { date:`${parts.year}-${parts.month}-${parts.day}`, day:map[parts.weekday], minutes:Number(parts.hour)*60+Number(parts.minute) };
}

function addDays(iso: string, amount: number) {
  const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+amount); return d.toISOString().slice(0,10);
}

function weekLabel(number: number) {
  const names = ['','الأول','الثاني','الثالث','الرابع','الخامس','السادس','السابع','الثامن','التاسع','العاشر'];
  return `الأسبوع ${names[number] || number}`;
}

function weekRange(number: number) {
  const startSunday = '2026-09-06';
  const sunday = addDays(startSunday, (number - 2) * 7);
  return { sunday, saturday: addDays(sunday, 6) };
}

function weekInfo() {
  const now = riyadhParts();
  let sunday = addDays(now.date, -now.day);
  if (now.day === 0 && now.minutes < 900) sunday = addDays(sunday, -7);
  const start = new Date('2026-09-06T12:00:00Z');
  const current = new Date(`${sunday}T12:00:00Z`);
  const number = 2 + Math.max(0, Math.round((current.getTime()-start.getTime())/604800000));
  return { ...now, sunday, saturday:addDays(sunday,6), number, label:weekLabel(number) };
}

async function verifyStudent(body: any) {
  const id = String(body.id || body.studentId || '');
  const password = String(body.password || body.pw || '');
  if (!id || !password) return null;
  const result = await rpc('edge_student_verify', { p_code:id, p_password:password });
  return Number(result || 0) || null;
}

async function requireSupervisor(req: Request) {
  const token = req.headers.get('x-hawaya-session') || '';
  if (!token) return null;
  const rows = await rpc('edge_supervisor_session', { p_token_hash:await sha256(token) });
  return Array.isArray(rows) ? rows[0] : null;
}

async function rows(path: string) { return (await db(path, { headers:{ Prefer:'return=representation' } })) || []; }


const POINT_STAGES=['elementary_456','middle','secondary'];
function pointStage(value:unknown){
 const stage=String(value||'');
 if(POINT_STAGES.includes(stage))return stage;
 if(stage==='ابتدائي'||stage==='رابع+خامس+سادس')return 'elementary_456';
 if(stage==='متوسط')return 'middle';
 if(stage==='ثانوي')return 'secondary';
 return '';
}
function socialUuid(value: unknown) {
 const id=String(value||'');
 return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)?id:null;
}

async function socialContext(body:any, supervisor:any=null) {
 const channel=body.channel==='chat'?'chat':'tweets';
 let stage='',student:any=null,group:any=null;
 if(supervisor){
  stage=pointStage(body.stage)||'';
  if(!stage)return {error:'اختر المرحلة أولًا'};
  if(channel==='chat'){
   const gid=socialUuid(body.groupId);if(!gid)return {error:'اختر المجموعة'};
   group=(await rows(`/groups?id=eq.${gid}&active=eq.true&stage_category=eq.${stage}&select=id,name`))[0];
   if(!group)return {error:'المجموعة غير موجودة في المرحلة'};
  }
 }else{
  const sid=await verifyStudent(body);if(!sid)return {error:'بيانات الدخول غير صحيحة'};
  student=(await rows(`/students?id=eq.${sid}&active=eq.true&select=id,full_name,grade,photo_url`))[0];
  if(!student)return {error:'حساب الطالب غير متاح'};
  stage=stageCategory(student.grade);
  const membership=(await rows(`/group_memberships?student_id=eq.${sid}&left_at=is.null&select=group_id&limit=1`))[0];
  if(membership)group=(await rows(`/groups?id=eq.${membership.group_id}&active=eq.true&select=id,name`))[0]||null;
 }
 const setting=(await rows(`/tweet_stage_settings?stage_category=eq.${stage}&select=enabled`))[0];
 const enabled=setting?.enabled===true;
 const filter=channel==='tweets'?`stage_category=eq.${stage}&channel=eq.tweets&group_id=is.null&deleted_at=is.null`:
  group?`group_id=eq.${group.id}&channel=eq.chat&deleted_at=is.null`:null;
 return {stage,channel,student,group,enabled,filter};
}

async function socialFeed(ctx:any) {
 if(!ctx.filter)return [];
 const list=await rows(`/hawaya_social_messages?${ctx.filter}&order=created_at.desc,id.desc&limit=100&select=id,body,author_name,author_student_id,author_supervisor_id,created_at,students(photo_url)`);
 const likes=list.length?await rows(`/hawaya_social_likes?message_id=in.(${list.map((m:any)=>m.id).join(',')})&select=message_id,student_id&limit=20000`):[];
 const count:Record<string,number>={},liked=new Set();
 for(const like of likes){count[like.message_id]=(count[like.message_id]||0)+1;if(like.student_id===ctx.student?.id)liked.add(like.message_id);}
 if(ctx.channel==='chat')list.reverse();
 return list.map((m:any)=>({id:m.id,name:m.author_name,text:m.body,createdAt:m.created_at,
 imageUrl:m.students?.photo_url||'',supervisor:!!m.author_supervisor_id,likes:count[m.id]||0,liked:liked.has(m.id),
 mine:!!ctx.student&&m.author_student_id===ctx.student.id}));
}

async function socialAction(body:any,supervisor:any=null) {
 const ctx:any=await socialContext(body,supervisor);if(ctx.error)return {success:false,error:ctx.error};
 const info={stage:ctx.stage,stageLabel:categoryLabel(ctx.stage),enabled:ctx.enabled,hasGroup:!!ctx.group,groupName:ctx.group?.name||''};
 const action=String(body.action);
 if(!supervisor&&!ctx.enabled)return {success:true,...info,messages:[]};
 if(ctx.channel==='chat'&&!ctx.group)return {success:action.startsWith('get'),...info,messages:[],error:'لم تتم إضافتك إلى مجموعة بعد'};
 if(action==='postStudentSocial'||action==='postSupervisorSocial'){
  const text=String(body.text||'').trim();if(!text||Array.from(text).length>500)return {success:false,error:'اكتب نصًا من 1 إلى 500 حرف'};
  const messageId=socialUuid(body.messageId);if(!messageId)return {success:false,error:'أعد محاولة الإرسال'};
  const existing=(await rows(`/hawaya_social_messages?id=eq.${messageId}&select=id,author_student_id,author_supervisor_id`))[0];
  if(existing&&!(supervisor?existing.author_supervisor_id===supervisor.supervisor_id:existing.author_student_id===ctx.student.id))return {success:false,error:'رسالة غير صالحة'};
  if(!existing)await db('/hawaya_social_messages',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({
   id:messageId,stage_category:ctx.stage,channel:ctx.channel,group_id:ctx.channel==='chat'?ctx.group.id:null,
   author_student_id:supervisor?null:ctx.student.id,author_supervisor_id:supervisor?supervisor.supervisor_id:null,
   author_name:supervisor?supervisor.supervisor_name:ctx.student.full_name,body:text
  })});
 }
 if(action==='setStudentSocialLike'){
  if(ctx.channel!=='tweets')return {success:false,error:'الإعجاب متاح للتغريدات فقط'};
  const id=socialUuid(body.messageId);if(!id)return {success:false,error:'تغريدة غير صالحة'};
  if(!(await rows(`/hawaya_social_messages?id=eq.${id}&${ctx.filter}&select=id`))[0])return {success:false,error:'التغريدة غير متاحة'};
  if(body.liked===true)await db('/hawaya_social_likes',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({message_id:id,student_id:ctx.student.id})});
  else await db(`/hawaya_social_likes?message_id=eq.${id}&student_id=eq.${ctx.student.id}`,{method:'DELETE'});
 }
 if(action==='deleteSupervisorSocial'){
  const id=socialUuid(body.messageId);if(!id)return {success:false,error:'رسالة غير صالحة'};
  await db(`/hawaya_social_messages?id=eq.${id}&${ctx.filter}`,{method:'PATCH',body:JSON.stringify({deleted_at:new Date().toISOString()})});
 }
 return {success:true,...info,messages:await socialFeed(ctx)};
}


Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(req.method!=='POST')return json({success:false,error:'POST only'},405);
 try{
  const body=await req.json(),action=String(body.action||'');
  if(action==='getSocialVersion')return json({success:true,version:API_VERSION});
  if(['getStudentSocial','postStudentSocial','setStudentSocialLike'].includes(action))return json(await socialAction(body));
  const supervisor=await requireSupervisor(req);
  if(!supervisor)return json({success:false,error:'انتهت جلسة المشرف، سجل الدخول مجددًا'},401);
  if(['getSupervisorSocial','postSupervisorSocial','deleteSupervisorSocial'].includes(action))return json(await socialAction(body,supervisor));
  if(action==='setSocialStageEnabled'){
   const stage=pointStage(body.stage);if(!stage||typeof body.enabled!=='boolean')return json({success:false,error:'اختر المرحلة'},400);
   const saved=await db(`/tweet_stage_settings?stage_category=eq.${stage}`,{method:'PATCH',body:JSON.stringify({enabled:body.enabled,updated_at:new Date().toISOString()})});
   return json({success:!!saved?.[0],enabled:saved?.[0]?.enabled});
  }
  return json({success:false,error:'إجراء غير معروف'},400);
 }catch(error){console.error(error);return json({success:false,error:'تعذر الاتصال بخدمة التغريدات'},500);}
});
