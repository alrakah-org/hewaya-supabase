const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM,VirtualConsole}=require(process.env.JSDOM_PATH||'jsdom');
const html=fs.readFileSync(process.env.STUDENT_HTML||__dirname+'/../apps/student/index.html','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(){for(let i=0;i<5;i++)await tick();}
function setup({storageFailure=false,transientFailure=false,wrongPassword=false,widgetFailure=false}={}){
 const requests=[],errors=[];let attempts=0;
 const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!e.message.startsWith('Not implemented: navigation'))errors.push(e.message);});
 const dom=new JSDOM(html,{url:'https://fixture.test/apps/student/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
  w.matchMedia=()=>({matches:false});w.HTMLMediaElement.prototype.play=async()=>{};w.HTMLMediaElement.prototype.pause=()=>{};
  const timeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms)=>timeout(fn,ms===350?0:ms);
  if(storageFailure)Object.defineProperty(w,'localStorage',{get(){throw new w.DOMException('Storage denied','SecurityError');}});
  if(widgetFailure)w.hawayaPush={onLogin(){throw new Error('Optional widget failed');},disconnect:async()=>{}};
  w.fetch=async(_,options)=>{
   const p=JSON.parse(options.body);requests.push(p);
   if(p.action==='studentLogin'){
    attempts++;
    if(transientFailure&&attempts===1)throw new TypeError('Failed to fetch');
    return {ok:true,json:async()=>wrongPassword?{success:false,error:'بيانات الدخول غير صحيحة'}:{success:true,id:'fixture',name:'طالب تجريبي',stage:'سادس ابتدائي',balance:100}};
   }
   const data={success:true,enabled:true,hasGroup:false,messages:[],announcements:[],log:[],items:[],groupActivity:[],days:[],selectedDay:{key:'thu',label:'الخميس',date:'2026-10-29'},weekLabel:'الأسبوع التاسع'};
   return {ok:true,json:async()=>data};
  };
 }});
 const el=id=>dom.window.document.getElementById(id);
 return {dom,el,requests,errors,get attempts(){return attempts;},async login(){el('loginId').value='fixture';el('loginPw').value='synthetic-password';el('loginForm').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await settle();},close:()=>dom.window.close()};
}

test('blocked device storage does not turn successful authentication into a connection error',async()=>{
 const h=setup({storageFailure:true});try{
  await h.login();assert.equal(h.el('appView').classList.contains('hidden'),false);assert.equal(h.el('loginError').textContent,'');
  for(const index of [1,3,4,5,0]){h.dom.window.document.querySelector('.nav-btn[data-index="'+index+'"]').click();assert.equal(h.dom.window.document.querySelector('.nav-btn.active').dataset.index,String(index));}
  await settle();assert.ok(h.requests.some(p=>p.action==='getStudentGroupData'&&p.id==='fixture'&&p.password==='synthetic-password'));
  h.el('logoutBtn').click();await settle();assert.equal(h.dom.window.hawayaPushConfig.session(),null);assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});
test('a temporary login connection failure retries once without duplicating write requests',async()=>{
 const h=setup({transientFailure:true});try{await h.login();await new Promise(r=>setTimeout(r,30));await settle();assert.equal(h.attempts,2);assert.equal(h.el('appView').classList.contains('hidden'),false);assert.equal(h.requests.some(p=>p.action.startsWith('save')||p.action.startsWith('post')),false);}finally{h.close();}
});
test('incorrect credentials are not retried and do not open the app',async()=>{
 const h=setup({wrongPassword:true});try{await h.login();assert.equal(h.attempts,1);assert.equal(h.el('appView').classList.contains('hidden'),true);assert.match(h.el('loginError').textContent,/بيانات الدخول غير صحيحة/);assert.equal(h.el('loginBtn').disabled,false);}finally{h.close();}
});
test('optional notification initialization cannot undo login or block navigation',async()=>{
 const h=setup({widgetFailure:true});try{await h.login();assert.equal(h.el('appView').classList.contains('hidden'),false);assert.equal(h.el('loginError').textContent,'');h.dom.window.document.querySelector('.nav-btn[data-index="1"]').click();assert.equal(h.dom.window.document.querySelector('.nav-btn.active').dataset.index,'1');assert.deepEqual(h.errors,[]);}finally{h.close();}
});
