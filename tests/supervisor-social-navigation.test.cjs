const {JSDOM,VirtualConsole}=require(process.env.JSDOM_PATH||'jsdom');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{createHash}=require('node:crypto');
const html=fs.readFileSync(process.env.SUPERVISOR_HTML||__dirname+'/../apps/supervisor/index.html','utf8');
const tick=()=>new Promise(r=>setImmediate(r)),STORE='hawaya_supervisor_social_cache_v1';
const G1='10000000-0000-4000-8000-000000000001',G2='10000000-0000-4000-8000-000000000002';
function setup({cached=null,token='synthetic-session'}={}){
 let now=Date.now(),tid=90000;const requests=[],pending=[],errors=[],intervals=[],timers=new Map();
 const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(html,{url:'https://alrakah-org.github.io/hewaya-supabase/apps/supervisor/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
  w.TextEncoder=TextEncoder;w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});w.Date.now=()=>now;
  Object.defineProperty(w.crypto,'subtle',{value:{digest:async(_,bytes)=>createHash('sha256').update(bytes).digest()}});
  w.localStorage.setItem('hawaya_supervisor_session',JSON.stringify({name:'فارس مقبول',token,expiresAt:'2030-01-01T00:00:00Z'}));if(cached)w.localStorage.setItem(STORE,cached);
  const originalTimeout=w.setTimeout.bind(w),originalClear=w.clearTimeout.bind(w);
  w.setTimeout=(fn,ms)=>{if(ms===250||ms===25000){timers.set(++tid,{fn,ms});return tid;}return originalTimeout(fn,ms);};
  w.clearTimeout=id=>{if(timers.has(id))timers.delete(id);else originalClear(id);};
  w.setInterval=(fn,ms)=>{intervals.push({fn,ms});return intervals.length;};
  w.fetch=async(url,o)=>{const p=JSON.parse(o.body);requests.push(p);
   if(['getSupervisorSocial','postSupervisorSocial','deleteSupervisorSocial','setSupervisorSocialPin','setSocialStageEnabled'].includes(p.action))return new Promise((resolve,reject)=>pending.push({p,signal:o.signal,resolve:(data,status=200)=>resolve({ok:status===200,status,json:async()=>data}),reject}));
   return{ok:true,json:async()=>({success:true,students:[],groups:[],weeks:[],items:[],announcements:[],logs:[]})};
  };
 }});
 const el=id=>dom.window.document.getElementById(id),social=()=>requests.filter(r=>r.action.includes('Social'));
 const select=(id,value)=>{el(id).value=value;el(id).dispatchEvent(new dom.window.Event('change'));};
 const bundle=(stage='متوسط',groupId=G1)=>({success:true,stage:stage==='متوسط'?'middle':'secondary',enabled:true,groups:[{id:groupId,name:'مجموعة '+stage}],feeds:[{channel:'tweets',groupId:null,messages:[{id:'tweet-one',text:'تغريدة '+stage,name:'مشرف',supervisor:true,createdAt:'2026-10-09T11:00:00Z',likes:0}]},{channel:'chat',groupId,messages:[{id:'chat-one',text:'محادثة '+stage,name:'طالب',createdAt:'2026-10-09T11:00:00Z'}]}]});
 const flush=()=>{for(const [id,t]of [...timers])if(t.ms===250){timers.delete(id);t.fn();}};
 return {dom,el,social,requests,pending,errors,select,bundle,flush,advance:()=>{now+=16000;},poll:()=>intervals.find(x=>x.ms===15000).fn(),snapshot:()=>dom.window.localStorage.getItem(STORE),close:()=>dom.window.close()};
}
async function warm(h){await tick();h.select('socialStage','متوسط');assert.equal(h.pending.length,1);h.pending.shift().resolve(h.bundle());await tick();}
test('one lightweight request preloads tweets and chat; repeated switching is immediate',async()=>{
 const h=setup();try{await warm(h);assert.match(h.el('socialFeed').textContent,/تغريدة متوسط/);
 const start=performance.now();h.select('socialGroup',G1);assert.match(h.el('socialFeed').textContent,/محادثة متوسط/);
 console.log('Supervisor cached group switch:',(performance.now()-start).toFixed(1),'ms');
 for(let n=0;n<20;n++){h.select('socialGroup','');h.select('socialGroup',G1);}
 assert.equal(h.social().length,1);assert.equal(h.requests.some(r=>r.action==='getGroups'),false);assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});
test('reopening restores messages and selected group before the network responds',async()=>{
 const h=setup();let saved;try{await warm(h);h.select('socialGroup',G1);h.flush();saved=h.snapshot();assert.ok(saved);assert.equal(saved.includes('synthetic-session'),false);}finally{h.close();}
 const reopened=setup({cached:saved});try{await tick();assert.equal(reopened.el('socialStage').value,'متوسط');assert.equal(reopened.el('socialGroup').value,G1);assert.match(reopened.el('socialFeed').textContent,/محادثة متوسط/);assert.equal(reopened.pending.length,1);assert.deepEqual(reopened.errors,[]);}finally{reopened.close();}
});
test('cache cannot move to another session and logout clears it',async()=>{
 const h=setup();let saved;try{await warm(h);h.flush();saved=h.snapshot();h.el('supervisorLogoutBtn').click();assert.equal(h.snapshot(),null);assert.doesNotMatch(h.el('socialFeed').textContent,/تغريدة متوسط/);}finally{h.close();}
 const other=setup({cached:saved,token:'different-session'});try{await tick();assert.equal(other.el('socialStage').value,'');assert.doesNotMatch(other.el('socialFeed').textContent,/تغريدة متوسط/);assert.equal(other.snapshot(),null);}finally{other.close();}
});
test('late stage responses populate their cache without replacing the current stage',async()=>{
 const h=setup();try{await tick();h.select('socialStage','متوسط');const first=h.pending.shift();h.select('socialStage','ثانوي');const second=h.pending.shift();
 first.resolve(h.bundle());await tick();assert.equal(h.el('socialStage').value,'ثانوي');assert.doesNotMatch(h.el('socialFeed').textContent,/تغريدة متوسط/);
 second.resolve(h.bundle('ثانوي',G2));await tick();assert.match(h.el('socialFeed').textContent,/تغريدة ثانوي/);
 h.select('socialStage','متوسط');assert.match(h.el('socialFeed').textContent,/تغريدة متوسط/);assert.equal(h.social().length,2);
 }finally{h.close();}
});
test('drafts and cached feed survive a failed refresh',async()=>{
 const h=setup();try{await warm(h);h.el('socialText').value='مسودة تغريدة';h.select('socialGroup',G1);h.el('socialText').value='مسودة محادثة';h.select('socialGroup','');assert.equal(h.el('socialText').value,'مسودة تغريدة');
 h.advance();h.poll();h.select('socialGroup',G1);assert.equal(h.el('socialText').value,'مسودة محادثة');h.pending.shift().reject(new Error('offline'));await tick();
 assert.match(h.el('socialFeed').textContent,/محادثة متوسط/);assert.equal(h.el('socialRetry').classList.contains('hidden'),false);
 h.el('socialRetry').click();assert.equal(h.pending.length,1);h.pending.shift().resolve(h.bundle());await tick();assert.equal(h.el('socialRetry').classList.contains('hidden'),true);
 }finally{h.close();}
});
test('slow refresh cannot undo pinning and mutation stays with the original thread',async()=>{
 const h=setup();try{await warm(h);h.advance();h.poll();const old=h.pending.shift();
 const pin=h.el('socialFeed').querySelector('[data-social-pin]');const action=h.el('socialFeed').onclick({target:pin});const write=h.pending.shift();assert.equal(old.signal.aborted,true);assert.equal(write.p.action,'setSupervisorSocialPin');
 h.select('socialGroup',G1);write.resolve({success:true,enabled:true,messages:[{...h.bundle().feeds[0].messages[0],pinned:true}]});await action;old.resolve(h.bundle());await tick();assert.match(h.el('socialFeed').textContent,/محادثة متوسط/);
 h.select('socialGroup','');assert.ok(h.el('socialFeed').querySelector('.social-pinned-label'));assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});
test('failed post retains draft and reuses the message id for safe retry',async()=>{
 const h=setup();try{await warm(h);h.el('socialText').value='رسالة جديدة';let action=h.el('socialForm').onsubmit({preventDefault(){}});const failed=h.pending.shift();failed.reject(new Error('offline'));await action;assert.equal(h.el('socialText').value,'رسالة جديدة');
 action=h.el('socialForm').onsubmit({preventDefault(){}});const retry=h.pending.shift();assert.equal(retry.p.messageId,failed.p.messageId);retry.resolve({success:true,enabled:true,messages:[{...h.bundle().feeds[0].messages[0],text:'رسالة جديدة'}]});await action;assert.equal(h.el('socialText').value,'');assert.match(h.el('socialFeed').textContent,/رسالة جديدة/);
 }finally{h.close();}
});
test('expired supervisor response clears saved data and displays login',async()=>{
 const h=setup();try{await warm(h);h.flush();h.advance();h.poll();h.pending.shift().resolve({},401);await tick();assert.equal(h.snapshot(),null);assert.equal(h.el('supervisorLoginView').classList.contains('hidden'),false);assert.doesNotMatch(h.el('socialFeed').textContent,/تغريدة متوسط/);
 }finally{h.close();}
});

test('student lists and rankings load only when their pages are opened',async()=>{
 const h=setup();try{await tick();assert.equal(h.requests.some(r=>['getStudentsByStage','getGroups','getRankingWeeks'].includes(r.action)),false);
 h.dom.window.document.querySelector('[data-index="0"]').click();await tick();assert.equal(h.requests.filter(r=>r.action==='getStudentsByStage').length,1);
 h.dom.window.document.querySelector('[data-index="5"]').click();await tick();assert.equal(h.requests.filter(r=>r.action==='getGroups').length,1);assert.equal(h.requests.filter(r=>r.action==='getRankingWeeks').length,1);
 }finally{h.close();}
});
test('delete and stage toggle update the correct view',async()=>{
 const h=setup();try{await warm(h);let action=h.el('socialFeed').onclick({target:h.el('socialFeed').querySelector('[data-social-delete]')});let write=h.pending.shift();assert.equal(write.p.action,'deleteSupervisorSocial');write.resolve({success:true,enabled:true,messages:[]});await action;assert.doesNotMatch(h.el('socialFeed').textContent,/تغريدة متوسط/);
 h.el('socialEnabled').checked=false;action=h.el('socialEnabled').onchange();write=h.pending.shift();assert.equal(write.p.action,'setSocialStageEnabled');assert.equal(write.p.stage,'متوسط');assert.equal(write.p.enabled,false);write.resolve({success:true,enabled:false});await action;assert.equal(h.el('socialEnabled').checked,false);assert.match(h.el('socialStatus').textContent,/معطلة/);assert.equal(h.el('socialStatus').closest('form'),null);
 }finally{h.close();}
});
