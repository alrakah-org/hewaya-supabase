// Full-page regression tests. Requires jsdom@26.1.0.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM,VirtualConsole}=require(process.env.JSDOM_PATH||'jsdom');
const html=fs.readFileSync(__dirname+'/../apps/student/index.html','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const points={success:true,weekLabel:'الأسبوع السادس',selectedDay:{key:'2026-10-11',label:'الأحد',date:'2026-10-11'},days:[{key:'2026-10-11',label:'اليوم',enabled:true}],items:[{key:'reading',label:'القراءة',points:10,maxChecks:3,count:1}],groupActivity:[]};
const group={success:true,hasGroup:true,group:{name:'مجموعة الاختبار',members:[{id:'fixture',name:'طالب الاختبار',balance:30}]}};
function setup(stage='متوسط'){
 const pending=[],requests=[],timers=[],errors=[];
 const vc=new VirtualConsole(); vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(html,{url:'https://alrakah-org.github.io/hewaya-supabase/apps/student/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
  w.localStorage.setItem('hawaya_student_session',JSON.stringify({id:'fixture',pw:'fixture-password'}));
  w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});
  w.HTMLMediaElement.prototype.play=async()=>{};w.HTMLMediaElement.prototype.pause=()=>{};
  w.setInterval=()=>1;
  const set=w.setTimeout.bind(w),clear=w.clearTimeout.bind(w);
  w.setTimeout=(fn,ms)=>{if(ms===20000){const timer={fn,cleared:false};timers.push(timer);return timer;}return set(fn,ms);};
  w.clearTimeout=id=>{if(typeof id==='object')id.cleared=true;else clear(id);};
  w.fetch=async(url,options)=>{
   const body=JSON.parse(options.body);requests.push(body);
   if(['getDayPointsContext','getStudentGroupData','saveDayPoints'].includes(body.action))return new Promise((resolve,reject)=>{
    options.signal?.addEventListener('abort',()=>reject(new w.DOMException('Timeout','AbortError')),{once:true});
    pending.push({body,signal:options.signal,resolve:(data,status=200)=>resolve({ok:status<400,status,json:async()=>data}),reject});
   });
   const data=body.action==='studentLogin'?{success:true,id:'fixture',name:'طالب الاختبار',stage,balance:30}:
    body.action==='getStudentSocial'?{success:true,enabled:false,stage:'middle',stageLabel:'متوسط',hasGroup:false,messages:[]}:
    {success:true,announcements:[],log:[],items:[]};
   return{ok:true,status:200,json:async()=>data};
  };
 }});
 const el=id=>dom.window.document.getElementById(id);
 const take=action=>{const i=pending.findIndex(p=>p.body.action===action);assert.ok(i>=0,'Expected request '+action);return pending.splice(i,1)[0];};
 const nav=()=>dom.window.document.querySelector('.nav-btn[data-index="1"]').click();
 return{dom,el,take,nav,requests,timers,errors,close:()=>dom.window.close()};
}
test('server timeout shows retry, never a false points lock, and retry recovers both sections',async()=>{
 const h=setup();try{
  await tick();h.nav();h.take('getDayPointsContext').resolve({},500);h.take('getStudentGroupData').resolve({},500);await tick();
  assert.equal(h.el('achievementsLockedCard').style.display,'none');
  assert.equal(h.el('achievementsErrorCard').style.display,'block');
  assert.match(h.el('myGroupContent').textContent,/تعذر تحميل المجموعة/);
  h.el('retryPointsBtn').click();h.take('getDayPointsContext').resolve(points);h.take('getStudentGroupData').resolve(group);await tick();
  assert.equal(h.el('achievementsErrorCard').style.display,'none');
  assert.equal(h.el('achievementsContent').style.display,'block');
  assert.equal(h.el('confirmAchievementsBtn').disabled,false);
  assert.match(h.el('myGroupContent').textContent,/مجموعة الاختبار/);
  assert.equal(h.el('retryPointsBtn').disabled,false);assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});
test('a server-declared opening schedule still locks points',async()=>{
 const h=setup();try{await tick();h.take('getDayPointsContext').resolve({success:false,error:'تفتح صفحة النقاط يوم الأحد الساعة 3:00 عصرًا'});await tick();
  assert.equal(h.el('achievementsLockedCard').style.display,'block');assert.equal(h.el('achievementsErrorCard').style.display,'none');assert.equal(h.el('achievementsContent').style.display,'none');
 }finally{h.close();}
});
test('failed verification is not misreported as no group or a closed points page',async()=>{
 const h=setup();try{await tick();h.nav();h.take('getDayPointsContext').resolve({success:false,error:'انتهت الجلسة، سجل الدخول مجددًا'});h.take('getStudentGroupData').resolve({success:false,error:'بيانات الدخول غير صحيحة'});await tick();
  assert.equal(h.el('achievementsLockedCard').style.display,'none');assert.equal(h.el('pointsLoginBtn').classList.contains('hidden'),false);
  assert.doesNotMatch(h.el('myGroupContent').textContent,/لم تتم إضافتك/);
  assert.ok(h.dom.window.localStorage.getItem('hawaya_student_session'),'Transient errors must not silently sign out');
  h.el('pointsLoginBtn').click();assert.equal(h.el('loginView').classList.contains('hidden'),false);assert.equal(h.dom.window.localStorage.getItem('hawaya_student_session'),null);
 }finally{h.close();}
});
test('successful empty membership is shown accurately and group retry is independent',async()=>{
 const h=setup();try{await tick();h.take('getDayPointsContext').resolve(points);h.nav();h.take('getStudentGroupData').reject(new Error('offline'));await tick();
  h.el('myGroupContent').querySelector('[data-retry-group]').click();h.take('getStudentGroupData').resolve({success:true,hasGroup:false});await tick();
  assert.match(h.el('myGroupContent').textContent,/لم تتم إضافتك إلى مجموعة/);
  assert.equal(h.el('achievementsContent').style.display,'block');
 }finally{h.close();}
});
test('rapid navigation shares pending group and points requests',async()=>{
 const h=setup();try{await tick();for(let i=0;i<15;i++)h.nav();
  assert.equal(h.requests.filter(p=>p.action==='getDayPointsContext').length,1);
  assert.equal(h.requests.filter(p=>p.action==='getStudentGroupData').length,1);
  h.take('getDayPointsContext').resolve(points);h.take('getStudentGroupData').resolve(group);await tick();assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});
test('hung requests abort with a usable retry and preserve the session',async()=>{
 const h=setup();try{await tick();h.nav();const p=h.take('getDayPointsContext'),g=h.take('getStudentGroupData');
  for(const timer of h.timers.filter(t=>!t.cleared))timer.fn();await tick();
  assert.equal(p.signal.aborted,true);assert.equal(g.signal.aborted,true);
  assert.equal(h.el('achievementsErrorCard').style.display,'block');assert.equal(h.el('achievementsLockedCard').style.display,'none');
  assert.ok(h.el('myGroupContent').querySelector('[data-retry-group]'));
  assert.ok(h.dom.window.localStorage.getItem('hawaya_student_session'));
 }finally{h.close();}
});
test('late responses from a previous account cannot display its group or points',async()=>{
 const h=setup();try{await tick();h.nav();const p=h.take('getDayPointsContext'),g=h.take('getStudentGroupData');
  h.dom.window.localStorage.setItem('hawaya_student_session',JSON.stringify({id:'another-fixture',pw:'other-password'}));
  p.resolve(points);g.resolve(group);await tick();
  assert.doesNotMatch(h.el('myGroupContent').textContent,/مجموعة الاختبار/);assert.equal(h.el('achievementsContent').style.display,'none');
 }finally{h.close();}
});
test('teacher-managed grades do not show connection or locked errors',async()=>{
 const h=setup('أول ابتدائي');try{await tick();
  assert.equal(h.requests.filter(p=>p.action==='getDayPointsContext').length,0);
  assert.equal(h.el('achievementsTeacherManagedCard').style.display,'block');assert.equal(h.el('achievementsErrorCard').style.display,'none');assert.equal(h.el('achievementsLockedCard').style.display,'none');
 }finally{h.close();}
});
test('a pending read cannot overwrite points that were just saved',async()=>{
 const h=setup();try{await tick();h.take('getDayPointsContext').resolve(points);await tick();
  h.el('confirmAchievementsBtn').click();const save=h.take('saveDayPoints');
  h.nav();const old=h.take('getDayPointsContext');h.take('getStudentGroupData').resolve(group);
  save.resolve({success:true});await tick();
  h.take('getDayPointsContext').resolve({...points,items:[{...points.items[0],count:2}]});await tick();
  old.resolve(points);await tick();assert.equal(h.el('dailyAchievementsList').querySelectorAll('input:checked').length,2);
  assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});
