const {JSDOM,VirtualConsole}=require(process.env.JSDOM_PATH||'jsdom');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const html=fs.readFileSync(process.env.STUDENT_HTML||__dirname+'/../apps/student/index.html','utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){
 const requests=[],pending=[],errors=[],intervals=[],timers=[];let now=100000;
 const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!e.message.startsWith('Not implemented: navigation'))errors.push(e.message);});
 const dom=new JSDOM(html,{url:'https://alrakah-org.github.io/hewaya-supabase/apps/student/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
  w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});w.Date.now=()=>now;
  w.localStorage.setItem('hawaya_student_session',JSON.stringify({id:'fixture',pw:'test'}));
  w.setInterval=(fn,ms)=>{intervals.push({fn,ms});return intervals.length;};
  const originalTimeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms)=>{if(ms===25000){timers.push(fn);return 12345;}return originalTimeout(fn,ms);};
  w.HTMLMediaElement.prototype.play=async()=>{};w.HTMLMediaElement.prototype.pause=()=>{};
  w.fetch=async(url,o)=>{
   const p=JSON.parse(o.body);requests.push(p);
   if(p.action==='getStudentSocial'||p.action==='postStudentSocial'||p.action==='setStudentSocialLike')return new Promise((resolve,reject)=>{pending.push({p,resolve:data=>resolve({ok:true,json:async()=>data}),reject,signal:o.signal});});
   return{ok:true,json:async()=>p.action==='studentLogin'?{success:true,id:p.id,name:'طالب',stage:'متوسط',balance:0}:{success:true,items:[],announcements:[],logs:[]}};
  };
 }});
 const d=dom.window.document,el=id=>d.getElementById(id);
 const social=()=>requests.filter(p=>p.action.includes('Social'));
 const info={stage:'middle',stageLabel:'متوسط',enabled:true,hasGroup:true,groupId:'group-one',groupName:'مجموعتي'};
 const tweet={id:'one',text:'تغريدة محفوظة',name:'مشرف',supervisor:true,likes:0,createdAt:'2026-10-09T11:00:00Z'};
 const chat={id:'two',text:'رسالة محفوظة',name:'طالب',createdAt:'2026-10-09T11:00:00Z'};
 const bundle=(extra={})=>{const details={...info,...extra};return{success:true,...details,messages:details.enabled?[tweet]:[],channels:{tweets:{...details,messages:details.enabled?[tweet]:[]},chat:{...details,messages:details.enabled&&details.hasGroup?[chat]:[]}}};};
 return {dom,d,el,pending,errors,social,bundle,info,tweet,chat,advance:()=>{now+=16000;},poll:()=>intervals.find(x=>x.ms===15000).fn(),expire:()=>timers.at(-1)(),close:()=>dom.window.close()};
}
test('slow initial request switches tabs immediately and rapid taps share one request',async()=>{
 const h=setup();try{await tick();assert.equal(h.social().length,1);
 h.el('studentChatTab').click();assert.equal(h.el('studentChatTab').getAttribute('aria-selected'),'true');assert.equal(h.el('studentSocialFeedTitle').textContent,'محادثة مجموعتي');
 for(let n=0;n<20;n++){h.el('studentTweetsTab').click();h.el('studentChatTab').click();}
 assert.equal(h.social().length,1);
 h.pending.shift().resolve(h.bundle());await tick();assert.match(h.el('studentSocialFeed').textContent,/رسالة محفوظة/);
 const start=performance.now();h.el('studentTweetsTab').click();const elapsed=performance.now()-start;
 assert.match(h.el('studentSocialFeed').textContent,/تغريدة محفوظة/);assert.ok(elapsed<100,'Cached tab must render synchronously');
 assert.equal(h.social().length,1);assert.deepEqual(h.errors,[]);console.log('Cached tab switch:',elapsed.toFixed(1),'ms; 40 rapid taps: 1 shared read');
 }finally{h.close();}
});
test('drafts survive switching and background failures retain the feed with retry',async()=>{
 const h=setup();try{await tick();h.pending.shift().resolve(h.bundle());await tick();
 h.el('studentSocialText').value='مسودة تغريدة';h.el('studentSocialText').dispatchEvent(new h.dom.window.Event('input'));
 h.el('studentChatTab').click();h.el('studentSocialText').value='مسودة محادثة';h.el('studentSocialText').dispatchEvent(new h.dom.window.Event('input'));
 h.el('studentTweetsTab').click();assert.equal(h.el('studentSocialText').value,'مسودة تغريدة');
 h.advance();h.poll();assert.match(h.el('studentSocialFeed').textContent,/تغريدة محفوظة/);
 h.el('studentChatTab').click();assert.equal(h.el('studentSocialText').value,'مسودة محادثة');
 assert.equal(h.social().length,2);h.pending.shift().reject(new Error('offline'));await tick();
 assert.match(h.el('studentSocialFeed').textContent,/رسالة محفوظة/);assert.equal(h.el('studentSocialRetry').classList.contains('hidden'),false);
 h.el('studentSocialRetry').click();assert.equal(h.social().length,3);h.pending.shift().resolve(h.bundle());await tick();assert.equal(h.el('studentSocialRetry').classList.contains('hidden'),true);
 }finally{h.close();}
});
test('disabled stage is instant in both tabs and background enable refreshes both',async()=>{
 const h=setup();try{await tick();h.pending.shift().resolve(h.bundle({enabled:false}));await tick();
 h.el('studentChatTab').click();assert.match(h.el('studentSocialMessage').textContent,/المحادثات معطلة/);assert.equal(h.el('studentSocialForm').classList.contains('hidden'),true);assert.equal(h.social().length,1);
 h.el('studentTweetsTab').click();assert.match(h.el('studentSocialMessage').textContent,/التغريدات معطلة/);
 h.advance();h.poll();h.pending.shift().resolve(h.bundle());await tick();assert.equal(h.el('studentSocialForm').classList.contains('hidden'),false);
 }finally{h.close();}
});
test('an older refresh cannot overwrite a successful post',async()=>{
 const h=setup();try{await tick();h.pending.shift().resolve(h.bundle());await tick();h.advance();h.poll();const old=h.pending.shift();
 h.el('studentSocialText').value='تغريدة جديدة';const submit=h.el('studentSocialForm').onsubmit({preventDefault(){}});const post=h.pending.shift();assert.equal(post.p.action,'postStudentSocial');assert.equal(old.signal.aborted,true);
 post.resolve({success:true,...h.info,messages:[{...h.tweet,text:'تغريدة جديدة'}]});await submit;old.resolve(h.bundle());await tick();
 assert.match(h.el('studentSocialFeed').textContent,/تغريدة جديدة/);assert.equal(h.el('studentSocialText').value,'');assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});
test('logout clears both caches and ignores requests from the previous account',async()=>{
 const h=setup();try{await tick();const old=h.pending.shift();h.el('logoutBtn').click();assert.equal(old.signal.aborted,true);old.resolve(h.bundle());await tick();assert.equal(h.el('studentSocialFeed').textContent,'');
 h.dom.window.localStorage.setItem('hawaya_student_session',JSON.stringify({id:'different',pw:'other'}));h.dom.window.resetStudentSocial();
 h.el('studentChatTab').click();assert.equal(h.el('studentSocialFeed').textContent,'');assert.match(h.el('studentSocialMessage').textContent,/جاري التحميل/);assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});
test('pending timeout leaves a usable retry and does not display a closed-stage message',async()=>{
 const h=setup();try{await tick();const pending=h.pending.shift();h.expire();assert.equal(pending.signal.aborted,true);pending.reject(new Error('timeout'));await tick();
 assert.match(h.el('studentSocialMessage').textContent,/تعذر التحميل/);assert.equal(h.el('studentSocialRetry').classList.contains('hidden'),false);
 }finally{h.close();}
});
