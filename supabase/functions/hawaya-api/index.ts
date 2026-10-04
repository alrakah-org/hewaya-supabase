declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Response | Promise<Response>): void };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REST = `${SUPABASE_URL}/rest/v1`;
const API_VERSION = 'point-stages-20261004';

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

async function balances(studentIds: number[], week?: number | null) {
  const ids=[...new Set(studentIds.map(Number).filter(Boolean))];
  const result:Record<number,number>={};
  ids.forEach((id)=>{ result[id]=0; });
  if(!ids.length)return result;
  const filter=`student_id=in.(${ids.join(',')})`;
  const wf=week?`&week_number=eq.${week}`:'';
  const wi=week?weekRange(Number(week)):null;
  const [awards,attendance,tx]=await Promise.all([
    rows(`/point_awards?${filter}${wf}&select=student_id,total_points`),
    rows(`/attendance?${filter}&select=student_id,points${wi?`&attendance_date=gte.${wi.sunday}&attendance_date=lte.${wi.saturday}`:''}`),
    rows(`/point_transactions?${filter}${wf}&select=student_id,amount`)
  ]);
  awards.forEach((x:any)=>{result[Number(x.student_id)]=(result[Number(x.student_id)]||0)+Number(x.total_points||0)});
  attendance.forEach((x:any)=>{result[Number(x.student_id)]=(result[Number(x.student_id)]||0)+Number(x.points||0)});
  tx.forEach((x:any)=>{result[Number(x.student_id)]=(result[Number(x.student_id)]||0)+Number(x.amount||0)});
  return result;
}

async function balance(studentId: number, week?: number | null) {
  return (await balances([studentId],week))[Number(studentId)]||0;
}

async function studentRecord(studentId: number) {
  const x = (await rows(`/students?id=eq.${studentId}&select=*`))[0];
  if (!x) return null;
  return { id:x.student_code, dbId:x.id, name:x.full_name, stage:x.grade, imageUrl:x.photo_url || '', balance:await balance(x.id) };
}

async function supervisorLogin(body:any) {
  const token = crypto.randomUUID()+crypto.randomUUID();
  const expires = new Date(Date.now()+30*24*3600*1000).toISOString();
  const result = await rpc('edge_supervisor_login', { p_name:String(body.name||''), p_pin:String(body.pin||''), p_token_hash:await sha256(token), p_expires_at:expires });
  if (!Array.isArray(result) || !result[0]) return { success:false, error:'الاسم أو الرقم السري غير صحيح' };
  return { success:true, name:result[0].supervisor_name, token, expiresAt:expires };
}

async function studentLogin(body:any) {
  const sid=await verifyStudent(body); if(!sid) return {success:false,error:'بيانات الدخول غير صحيحة'};
  const s=await studentRecord(sid); if(!s) return {success:false,error:'الحساب غير موجود'};
  const peers=await rows(`/students?grade=eq.${encodeURIComponent(s.stage)}&active=eq.true&select=id`);
  const values=await Promise.all(peers.map(async(x:any)=>({id:x.id,b:await balance(x.id)})));
  values.sort((a,b)=>b.b-a.b); const rank=values.findIndex(x=>x.id===sid)+1;
  return {success:true,...s,rank};
}

async function announcements() {
  const data=await rows('/announcements?active=eq.true&order=published_at.desc&select=id,body,image_url,published_at');
  return {success:true,announcements:data.map((x:any)=>({rowIndex:x.id,text:x.body||'',imageUrl:x.image_url||'',date:new Date(x.published_at).toLocaleDateString('ar-SA')}))};
}

async function dailyTip() {
  const x=(await rows('/tips?active=eq.true&order=published_at.desc&limit=1&select=body'))[0];
  return {success:true,tip:x?.body||''};
}

async function studentsList(stage='') {
  const q=stage ? `&grade=eq.${encodeURIComponent(stage)}` : '';
  const data=await rows(`/students?active=eq.true${q}&order=full_name.asc&select=*`);
  const totals=await balances(data.map((x:any)=>Number(x.id)));
  return data.map((x:any)=>({id:x.student_code,name:x.full_name,stage:x.grade,imageUrl:x.photo_url||'',balance:totals[Number(x.id)]||0,dbId:x.id}));
}

async function registerStudent(body:any) {
  const existing=await rows(`/students?student_code=eq.${encodeURIComponent(String(body.id))}&select=id`);
  if(existing[0]) return {success:false,error:'رقم الطالب مستخدم مسبقًا'};
  const inserted=await db('/students',{method:'POST',body:JSON.stringify({student_code:String(body.id),full_name:String(body.name||''),grade:String(body.stage||''),stage_category:stageCategory(String(body.stage||'')),photo_url:body.imageUrl||null,active:true})});
  const row=inserted[0]; await rpc('edge_set_student_password',{p_student_id:row.id,p_password:String(body.password||'')});
  return {success:true,id:row.student_code};
}

const POINT_STAGES = ['elementary_456', 'middle', 'secondary'];

function pointStage(value: unknown) {
  const stage = String(value || '');
  if (POINT_STAGES.includes(stage)) return stage;
  if (stage === 'ابتدائي' || stage === 'رابع+خامس+سادس') return 'elementary_456';
  if (stage === 'متوسط') return 'middle';
  if (stage === 'ثانوي') return 'secondary';
  return '';
}

function pointItem(x:any) {
  return {id:x.id,key:x.code,baseKey:x.base_code||x.code,stage:x.stage_category,
    label:x.name,points:x.points_per_mark,maxChecks:x.max_marks,type:x.limit_period,
    active:x.active,order:x.sort_order,allowedWeekdays:x.allowed_weekdays};
}

async function pointItems(includeInactive=false, stage:string) {
  if (!POINT_STAGES.includes(stage)) throw new Error('Invalid point stage');
  const filter = `${includeInactive?'':'active=eq.true&'}order=sort_order.asc&select=*`;
  // دعم الانتقال من البنود المشتركة إلى مجموعات المراحل دون انقطاع القراءة.
  const configured = await rows(`/point_items?stage_category=eq.${stage}&order=sort_order.asc&select=*`);
  const data = configured.length ? configured.filter((x:any)=>includeInactive||x.active)
    : await rows(`/point_items?stage_category=is.null&${filter}`);
  return data.map(pointItem);
}

async function savePointItem(body:any) {
  const item=body.item || body;
  const stage=pointStage(body.stage || item.stage);
  if(!stage)return {success:false,error:'اختر المرحلة أولًا'};
  const label=String(item.label||'').trim();
  const points=Number(item.points), maxMarks=Number(item.maxChecks);
  if(!label||label.length>100)return {success:false,error:'أدخل اسم بند لا يتجاوز 100 حرف'};
  if(!Number.isInteger(points)||points<1)return {success:false,error:'نقاط الدائرة يجب أن تكون عددًا صحيحًا أكبر من صفر'};
  if(!Number.isInteger(maxMarks)||maxMarks<1||maxMarks>20)return {success:false,error:'عدد الدوائر يجب أن يكون بين 1 و20'};
  const key=String(item.key||'');
  const existing=key?(await rows(`/point_items?code=eq.${encodeURIComponent(key)}&stage_category=eq.${stage}&select=*`))[0]:null;
  if(key&&!existing)return {success:false,error:'البند غير موجود في المرحلة المحددة. أعد تحميل البنود.'};
  const code=existing?.code||`item_${crypto.randomUUID()}__${stage}`;
  const payload={code,base_code:existing?.base_code||code,stage_category:stage,name:label,
    points_per_mark:points,max_marks:maxMarks,limit_period:'weekly',
    allowed_weekdays:existing?.allowed_weekdays||[0,1,2,3,4,5,6],
    active:existing?existing.active:item.active!==false,
    sort_order:existing?.sort_order??(Number.isInteger(Number(item.order))?Number(item.order):999)};
  const saved=key
    ?await db(`/point_items?id=eq.${existing.id}&stage_category=eq.${stage}`,{method:'PATCH',body:JSON.stringify(payload)})
    :await db('/point_items',{method:'POST',body:JSON.stringify(payload)});
  if(!saved?.[0])return {success:false,error:'لم يُحفظ البند. أعد المحاولة.'};
  return {success:true,key:code,stage,item:pointItem(saved[0])};
}

async function getDayContext(body:any) {
  const sid=await verifyStudent(body); if(!sid) return {success:false,error:'انتهت الجلسة، سجل الدخول مجددًا'};
  const wi=weekInfo();
  const open=!(wi.day===0&&wi.minutes<900); if(!open) return {success:false,error:'تفتح صفحة النقاط يوم الأحد الساعة 3:00 عصرًا'};
  const s=(await rows(`/students?id=eq.${sid}&select=id,student_code,grade`))[0];
  if(!s)return {success:false,error:'الطالب غير موجود'};
  const stage=stageCategory(s.grade);
  const items=await pointItems(false,stage);
  const awards=await rows(`/point_awards?student_id=eq.${sid}&week_number=eq.${wi.number}&select=quantity,point_items(code,base_code)`);
  const counts:Record<string,number>={}; awards.forEach((a:any)=>{const c=a.point_items?.base_code||a.point_items?.code;if(c)counts[c]=(counts[c]||0)+Number(a.quantity||0)});
  const allowed=items.filter((x:any)=>!x.allowedWeekdays?.length||x.allowedWeekdays.includes(wi.day));
  const gm=(await rows(`/group_memberships?student_id=eq.${sid}&left_at=is.null&select=group_id`))[0];
  let groupActivity:any[]=[];
  if(gm){
    const members=await rows(`/group_memberships?group_id=eq.${gm.group_id}&left_at=is.null&select=student_id,students(full_name)`);
    const memberIds=members.map((m:any)=>Number(m.student_id)).filter(Boolean);
    if(memberIds.length){
      const allAwards=await rows(`/point_awards?student_id=in.(${memberIds.join(',')})&activity_date=eq.${wi.date}&select=student_id,quantity,point_items(name)`);
      for(const m of members){
        const a=allAwards.filter((z:any)=>Number(z.student_id)===Number(m.student_id));
        if(a.length)groupActivity.push({name:m.students?.full_name||'',items:a.map((z:any)=>({count:z.quantity,label:z.point_items?.name||''})),score:a.reduce((n:number,z:any)=>n+Number(z.quantity||0),0)});
      }
    }
    groupActivity.sort((a,b)=>b.score-a.score);
  }
  return {success:true,stage,weekLabel:wi.label,selectedDay:{key:wi.date,label:['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'][wi.day],date:wi.date},days:[{key:wi.date,label:'اليوم',enabled:true}],items:allowed.map((x:any)=>({...x,count:counts[x.baseKey]||0})),groupActivity};
}

async function saveDayPoints(body:any) {
  const sid=await verifyStudent(body); if(!sid)return {success:false,error:'بيانات الدخول غير صحيحة'};
  const wi=weekInfo(); if(wi.day===0&&wi.minutes<900)return {success:false,error:'التسجيل لم يفتح بعد'};
  const student=(await rows(`/students?id=eq.${sid}&select=grade`))[0];
  if(!student)return {success:false,error:'الطالب غير موجود'};
  const stage=stageCategory(student.grade);
  const items=await pointItems(false,stage); const requested=body.counts||{};
  const validKeys=new Set(items.flatMap((x:any)=>[x.key,x.baseKey]));
  if(Object.values(requested).some(value=>!Number.isInteger(Number(value))||Number(value)<0))
    return {success:false,error:'عدد الدوائر غير صحيح'};
  if(Object.keys(requested).some(key=>!validKeys.has(key)&&Number(requested[key])>0))
    return {success:false,error:'تغيرت بنود مرحلتك. أعد تحميل صفحة النقاط.'};
  const previous=await rows(`/point_awards?student_id=eq.${sid}&week_number=eq.${wi.number}&select=quantity,point_items(code,base_code)`);
  for(const item of items){
    const requestedKey=item.key in requested?item.key:item.baseKey;
    if(!(requestedKey in requested))continue;
    const count=Number(requested[requestedKey]);
    if(!Number.isInteger(count)||count<0)return {success:false,error:'عدد الدوائر غير صحيح'};
    const prev=previous.filter((x:any)=>(x.point_items?.base_code||x.point_items?.code)===item.baseKey).reduce((n:number,x:any)=>n+Number(x.quantity||0),0);
    const wanted=Math.min(Number(item.maxChecks),Math.max(prev,count));
    const delta=wanted-prev; if(delta<=0)continue;
    if(item.allowedWeekdays?.length&&!item.allowedWeekdays.includes(wi.day))continue;
    await db('/point_awards',{method:'POST',body:JSON.stringify({student_id:sid,point_item_id:item.id,activity_date:wi.date,week_number:wi.number,quantity:delta,unit_points:item.points,source:'student',note:null})});
  }
  return {success:true,modifiedOtherDay:false};
}

async function attendanceStatus(body:any) {
  const sid=await verifyStudent(body); if(!sid)return {success:false,error:'بيانات الدخول غير صحيحة'};
  const wi=riyadhParts(); const allowed=[0,2,4].includes(wi.day)&&wi.minutes>=900&&wi.minutes<=1439;
  const existing=(await rows(`/attendance?student_id=eq.${sid}&attendance_date=eq.${wi.date}&select=attendance_type`))[0];
  const reason=allowed?'':'الحضور متاح الأحد والثلاثاء والخميس من 3 عصرًا إلى 11:59 مساءً';
  return {success:true,allowed,available:allowed,alreadyMarked:!!existing,tier:existing?.attendance_type,reason,error:reason};
}

async function markAttendance(body:any, source='student') {
  const sid=source==='student'?await verifyStudent(body):Number((await rows(`/students?student_code=eq.${encodeURIComponent(String(body.id||body.rawScan||''))}&select=id`))[0]?.id||0);
  if(!sid)return {success:false,error:'الطالب غير موجود'};
  const wi=riyadhParts(); const found=(await rows(`/attendance?student_id=eq.${sid}&attendance_date=eq.${wi.date}&select=id,attendance_type,points`))[0];
  if(found)return {success:true,alreadyMarked:true,pointsAdded:0,tier:found.attendance_type==='early'?'مبكر':'عادي',session:'مسائي',student:await studentRecord(sid)};
  if(source==='student'&&(![0,2,4].includes(wi.day)||wi.minutes<900))return {success:false,error:'التسجيل غير متاح الآن'};
  const tier=body.tier==='early'||body.tier==='مبكر'?'early':'normal'; const points=tier==='early'?300:100;
  await db('/attendance',{method:'POST',body:JSON.stringify({student_id:sid,attendance_date:wi.date,attendance_type:tier,points,source})});
  return {success:true,pointsAdded:points,tier:tier==='early'?'مبكر':'عادي',session:'مسائي',student:await studentRecord(sid)};
}

async function groups(stage='', week: number | null = null) {
  const cat=stageCategory(stage);
  const data=await rows(`/groups?active=eq.true${stage?`&stage_category=eq.${cat}`:''}&order=name.asc&select=*`);
  const allMemberships=await rows('/group_memberships?left_at=is.null&select=group_id,student_id,students(student_code,full_name,grade)');
  const totals=await balances(allMemberships.map((m:any)=>Number(m.student_id)), week);
  return data.map((g:any)=>{
    const members=allMemberships.filter((m:any)=>m.group_id===g.id).map((m:any)=>({
      id:m.students?.student_code,
      dbId:Number(m.student_id),
      name:m.students?.full_name||'',
      stage:m.students?.grade||'',
      balance:totals[Number(m.student_id)]||0
    })).sort((a:any,b:any)=>b.balance-a.balance||String(a.name).localeCompare(String(b.name),'ar'));
    return {id:g.id,name:g.name,stage:categoryLabel(g.stage_category),members,totalPoints:members.reduce((n:number,x:any)=>n+x.balance,0)};
  });
}

async function pointsLog(body:any) {
  const s=(await rows(`/students?student_code=eq.${encodeURIComponent(String(body.id||''))}&select=id`))[0]; if(!s)return {success:false,log:[]};
  const [a,t,at]=await Promise.all([
    rows(`/point_awards?student_id=eq.${s.id}&order=created_at.desc&select=activity_date,quantity,total_points,note,created_at,point_items(name)`),
    rows(`/point_transactions?student_id=eq.${s.id}&order=created_at.desc&select=activity_date,amount,reason,created_at,supervisor_name`),
    rows(`/attendance?student_id=eq.${s.id}&order=created_at.desc&select=attendance_date,points,attendance_type,created_at`)
  ]);
  const log=[...a.map((x:any)=>({date:x.activity_date,amount:x.total_points,total:x.total_points,count:x.quantity,label:x.point_items?.name||'',reason:x.point_items?.name||'',created_at:x.created_at})),...t.map((x:any)=>({date:x.activity_date,amount:x.amount,total:x.amount,count:1,label:x.reason,reason:x.reason,created_at:x.created_at})),...at.map((x:any)=>({date:x.attendance_date,amount:x.points,total:x.points,count:1,label:x.attendance_type==='early'?'حضور مبكر':'حضور عادي',reason:'الحضور',created_at:x.created_at}))].sort((x,y)=>String(y.created_at).localeCompare(String(x.created_at)));
  return {success:true,log};
}

Deno.serve(async (req) => {
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({success:false,error:'POST only'},405);
  try{
    const body=await req.json(); const action=String(body.action||'');
    if(action==='getAppVersion')return json({success:true,version:API_VERSION,pointStages:POINT_STAGES});
    if(action==='supervisorLogin')return json(await supervisorLogin(body));
    if(action==='studentLogin')return json(await studentLogin(body));
    if(action==='getAnnouncements')return json(await announcements());
    if(action==='getDailyTip')return json(await dailyTip());
    if(action==='getStudentAttendanceStatus')return json(await attendanceStatus(body));
    if(action==='studentMarkAttendance')return json(await markAttendance(body,'student'));
    if(action==='getDayPointsContext')return json(await getDayContext(body));
    if(action==='saveDayPoints')return json(await saveDayPoints(body));
    if(action==='getPointsLog'||action==='getStudentDetailedPointsLog')return json(await pointsLog(body));
    if(action==='getLeaderboard')return json({success:true,leaderboard:(await studentsList(body.stage||'')).sort((a,b)=>b.balance-a.balance)});
    if(action==='getStudentGroupData'){
      const sid=await verifyStudent(body); if(!sid)return json({success:false,error:'بيانات الدخول غير صحيحة'});
      const gm=(await rows(`/group_memberships?student_id=eq.${sid}&left_at=is.null&select=group_id`))[0];
      if(!gm)return json({success:true,hasGroup:false});
      const g=(await rows(`/groups?id=eq.${gm.group_id}&active=eq.true&select=id,name,stage_category`))[0];
      if(!g)return json({success:true,hasGroup:false});
      const memberships=await rows(`/group_memberships?group_id=eq.${gm.group_id}&left_at=is.null&select=student_id,students(student_code,full_name,grade)`);
      const members=await Promise.all(memberships.map(async(m:any)=>({
        id:m.students?.student_code,
        name:m.students?.full_name||'',
        stage:m.students?.grade||'',
        balance:await balance(m.student_id)
      })));
      members.sort((a:any,b:any)=>b.balance-a.balance||String(a.name).localeCompare(String(b.name),'ar'));
      const group={id:g.id,name:g.name,stage:categoryLabel(g.stage_category),members};
      return json({success:true,hasGroup:true,group});
    }
    if(action==='updateStudentPhoto'){
      const sid=await verifyStudent(body); if(!sid)return json({success:false,error:'بيانات الدخول غير صحيحة'});
      await db(`/students?id=eq.${sid}`,{method:'PATCH',body:JSON.stringify({photo_url:body.imageUrl||null})}); return json({success:true,imageUrl:body.imageUrl||''});
    }

    const supervisor=await requireSupervisor(req); if(!supervisor)return json({success:false,error:'انتهت جلسة المشرف، سجل الدخول مجددًا'},401);
    if(action==='generatePreview'){
      let id=''; do{id=String(Math.floor(100000+Math.random()*900000));}while((await rows(`/students?student_code=eq.${id}&select=id`))[0]);
      const password=String(Math.floor(1000+Math.random()*9000)); return json({success:true,id,password,name:body.name,stage:body.stage,imageUrl:body.imageUrl||''});
    }
    if(action==='confirmRegister')return json(await registerStudent(body));
    if(action==='bulkRegisterStudents'){
      const results=[]; for(const name of (body.names||[])){let id='';do{id=String(Math.floor(100000+Math.random()*900000));}while((await rows(`/students?student_code=eq.${id}&select=id`))[0]);const password=String(Math.floor(1000+Math.random()*9000));const r=await registerStudent({id,password,name,stage:body.stage});results.push({success:r.success,id,password,name,stage:body.stage});} return json({success:true,results});
    }
    if(action==='getStudentsByStage')return json({success:true,students:await studentsList(body.stage||'')});
    if(action==='updateStudentInfo'){
      const s=(await rows(`/students?student_code=eq.${encodeURIComponent(String(body.id))}&select=id`))[0]; if(!s)return json({success:false,error:'الطالب غير موجود'});
      await db(`/students?id=eq.${s.id}`,{method:'PATCH',body:JSON.stringify({full_name:body.name,grade:body.stage,stage_category:stageCategory(body.stage),...(body.imageUrl?{photo_url:body.imageUrl}:{})})}); return json({success:true});
    }
    if(action==='adjustPoints'||action==='bulkAdjustPoints'){
      const ids=action==='adjustPoints'?[body.id]:(body.ids||[]); const wi=weekInfo(); const results=[];
      for(const code of ids){const s=(await rows(`/students?student_code=eq.${encodeURIComponent(String(code))}&select=id`))[0];if(!s){results.push({id:code,success:false});continue;}await db('/point_transactions',{method:'POST',body:JSON.stringify({student_id:s.id,amount:Number(body.amount),reason:String(body.reason||'تعديل من المشرف'),supervisor_name:supervisor.supervisor_name,week_number:wi.number,activity_date:wi.date})});results.push({id:code,success:true,newBalance:await balance(s.id)});} return json(action==='adjustPoints'?{success:true,newBalance:results[0]?.newBalance}:{success:true,results});
    }
    if(action==='markAttendance')return json(await markAttendance({id:body.rawScan||body.id,tier:body.tier||'normal'},'supervisor'));
    if(action==='bulkMarkAttendance'){const results=[];for(const id of (body.ids||[]))results.push({id,...await markAttendance({id,tier:'normal'},'supervisor')});return json({success:true,results});}
    if(action==='getTodayAttendees'){const wi=riyadhParts();const a=await rows(`/attendance?attendance_date=eq.${wi.date}&select=students(student_code)`);return json({success:true,ids:a.map((x:any)=>x.students?.student_code).filter(Boolean)});}
    if(action==='addAnnouncement'){await db('/announcements',{method:'POST',body:JSON.stringify({body:body.text||'',image_url:body.imageUrl||null,active:true})});return json({success:true});}
    if(action==='deleteAnnouncement'){await db(`/announcements?id=eq.${body.rowIndex}`,{method:'DELETE'});return json({success:true});}
    if(action==='addTip'){await db('/tips',{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({active:false})}).catch(()=>{});await db('/tips',{method:'POST',body:JSON.stringify({body:body.text,active:true})});return json({success:true});}
    if(action==='getGroups')return json({success:true,groups:await groups(body.stage||'')});
    if(action==='saveGroup'){
      let gid=body.groupId; if(gid){await db(`/groups?id=eq.${gid}`,{method:'PATCH',body:JSON.stringify({name:body.name,stage_category:stageCategory(body.stage)})});await db(`/group_memberships?group_id=eq.${gid}&left_at=is.null`,{method:'PATCH',body:JSON.stringify({left_at:riyadhParts().date})});}else{const g=await db('/groups',{method:'POST',body:JSON.stringify({name:body.name,stage_category:stageCategory(body.stage),active:true})});gid=g[0].id;}
      for(const code of (body.studentIds||[])){const s=(await rows(`/students?student_code=eq.${encodeURIComponent(String(code))}&select=id`))[0];if(!s)continue;await db(`/group_memberships?student_id=eq.${s.id}&left_at=is.null`,{method:'PATCH',body:JSON.stringify({left_at:riyadhParts().date})});await db('/group_memberships',{method:'POST',body:JSON.stringify({group_id:gid,student_id:s.id,joined_at:riyadhParts().date})});}return json({success:true,groupId:gid});
    }
    if(action==='deleteGroup'){await db(`/groups?id=eq.${body.groupId}`,{method:'PATCH',body:JSON.stringify({active:false})});return json({success:true});}
    if(action==='getRankingWeeks'){
      const current=Math.max(2,weekInfo().number);
      const weeks=[{value:'all',label:'كل الأسابيع'}];
      for(let number=2;number<=current;number++)weeks.push({value:String(number),label:weekLabel(number)});
      return json({success:true,weeks,currentWeek:current});
    }
    if(action==='getAdvancedRanking'){
      const requestedWeek=String(body.weekNumber||'all');
      const week=requestedWeek==='all'?null:Number(requestedWeek);
      if(week!==null&&(!Number.isInteger(week)||week<2||week>weekInfo().number))return json({success:false,error:'الأسبوع المحدد غير متاح'},400);
      const gs=await groups(categoryLabel(stageCategory(body.category||'')),week);
      const selectedIds=new Set((body.groupIds||[]).map((x:any)=>String(x)));
      const selected=selectedIds.size?gs.filter((g:any)=>selectedIds.has(String(g.id))):gs;
      const studentIds=[...new Set(selected.flatMap((g:any)=>g.members.map((m:any)=>Number(m.dbId))).filter(Boolean))];
      const detailsByStudent:Record<number,Record<string,number>>={};
      const addDetail=(studentId:number,label:string,count:number)=>{if(!detailsByStudent[studentId])detailsByStudent[studentId]={};detailsByStudent[studentId][label]=(detailsByStudent[studentId][label]||0)+count;};
      if(body.details&&studentIds.length){
        const filter=`student_id=in.(${studentIds.join(',')})`;
        const range=week?weekRange(week):null;
        const [awardRows,attendanceRows,transactionRows]=await Promise.all([
          rows(`/point_awards?${filter}${week?`&week_number=eq.${week}`:''}&select=student_id,quantity,point_items(name)`),
          rows(`/attendance?${filter}${range?`&attendance_date=gte.${range.sunday}&attendance_date=lte.${range.saturday}`:''}&select=student_id,attendance_type`),
          rows(`/point_transactions?${filter}${week?`&week_number=eq.${week}`:''}&select=student_id,reason`)
        ]);
        awardRows.forEach((x:any)=>addDetail(Number(x.student_id),x.point_items?.name||'نقاط',Number(x.quantity||0)));
        attendanceRows.forEach((x:any)=>addDetail(Number(x.student_id),x.attendance_type==='early'?'حضور مبكر':'حضور عادي',1));
        transactionRows.forEach((x:any)=>addDetail(Number(x.student_id),x.reason||'نقاط مشرف',1));
      }
      const withDetails=selected.map((g:any)=>({...g,members:[...g.members].sort((a:any,b:any)=>b.balance-a.balance||String(a.name).localeCompare(String(b.name),'ar')).map((s:any)=>({...s,details:{items:Object.entries(detailsByStudent[Number(s.dbId)]||{}).map(([label,count])=>({label,count})),edits:[]}}))}));
      const columns=body.mode==='individuals'?[{id:'individuals',name:'ترتيب الأفراد',totalPoints:withDetails.flatMap((g:any)=>g.members).reduce((n:number,s:any)=>n+Number(s.balance||0),0),members:withDetails.flatMap((g:any)=>g.members).sort((a:any,b:any)=>b.balance-a.balance||String(a.name).localeCompare(String(b.name),'ar'))}]:withDetails;
      return json({success:true,columns,weekNumber:requestedWeek});
    }
    if(action==='getAchievementItems'){
      const stage=pointStage(body.stage);
      if(!stage)return json({success:false,error:'اختر المرحلة أولًا'},400);
      return json({success:true,stage,items:await pointItems(body.includeInactive===true||body.includeInactive==='true',stage)});
    }
    if(action==='saveAchievementItem')return json(await savePointItem(body));
    if(action==='toggleAchievementItem'){
      const stage=pointStage(body.stage);
      if(!stage)return json({success:false,error:'اختر المرحلة أولًا'},400);
      const saved=await db(`/point_items?code=eq.${encodeURIComponent(String(body.key))}&stage_category=eq.${stage}`,{method:'PATCH',body:JSON.stringify({active:body.active===true||body.active==='true'})});
      if(!saved?.[0])return json({success:false,error:'البند غير موجود في المرحلة المحددة'});
      return json({success:true,stage,item:pointItem(saved[0])});
    }
    if(['getRewards','getPurchaseRequests'].includes(action))return json({success:true,rewards:[],requests:[]});
    return json({success:false,error:`إجراء غير معروف: ${action}`},400);
  }catch(error){console.error(error);return json({success:false,error:'حدث خطأ في الخادم'},500);}
});
