const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM,VirtualConsole}=require('jsdom');
const tick=()=>new Promise(r=>setImmediate(r)),group='10000000-0000-4000-8000-000000000002';
async function setup(role,query){
 const requests=[],errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(fs.readFileSync(__dirname+'/../apps/'+role+'/index.html','utf8'),{url:'https://alrakah-org.github.io/hewaya-supabase/apps/'+role+'/?'+query,runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
  w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});w.TextEncoder=TextEncoder;
  Object.defineProperty(w.crypto,'subtle',{value:crypto.subtle});w.setInterval=()=>1;
  w.HTMLMediaElement.prototype.play=async()=>{};w.HTMLMediaElement.prototype.pause=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.localStorage.setItem('hawaya_'+role+'_session',JSON.stringify(role==='student'?{id:'fixture',pw:'synthetic-password'}:{name:'فارس مقبول',token:'synthetic-session',expiresAt:'2030-01-01T00:00:00Z'}));
  w.fetch=async(_,options)=>{const body=JSON.parse(options.body);requests.push(body);let data={success:true,items:[],announcements:[],log:[],logs:[]};
   if(body.action==='studentLogin')data={success:true,id:'fixture',name:'طالب الاختبار',stage:'متوسط',balance:30};
   if(body.action==='getStudentSocial'){const info={enabled:true,hasGroup:true,stage:'middle',stageLabel:'متوسط',groupId:group,groupName:'مجموعة الاختبار',messages:[]};data={success:true,...info,channels:{tweets:info,chat:info}};}
   if(body.action==='getSupervisorSocial')data={success:true,enabled:true,groups:[{id:group,name:'مجموعة الاختبار'}],feeds:[{channel:'tweets',groupId:null,messages:[]},{channel:'chat',groupId:group,messages:[]}]};
   return{ok:true,status:200,json:async()=>data};
  };
 }});
 for(let i=0;i<5;i++)await tick();
 assert.equal(typeof dom.window.hawayaPushConfig.session,'function');assert.ok(dom.window.hawayaPushConfig.session());
 dom.window.eval(fs.readFileSync(__dirname+'/../apps/shared/notifications.js','utf8'));
 return{dom,requests,errors,el:id=>dom.window.document.getElementById(id),close:()=>dom.window.close()};
}
test('student notification opens points directly with no stage selector',async()=>{
 const h=await setup('student','notify=points');try{assert.equal(h.dom.window.document.querySelector('.nav-btn.active').dataset.index,'1');assert.ok(h.requests.some(r=>r.action==='getStudentGroupData'));assert.deepEqual(h.errors,[]);h.el('pushOpenBtn').click();assert.ok(h.dom.window.document.querySelector('.push-dialog').open);}finally{h.close();}
});
test('student chat notification opens own group tab and public tweet opens tweets',async()=>{
 for(const kind of ['chat','tweets']){const h=await setup('student','notify='+kind);try{assert.equal(h.dom.window.document.querySelector('.nav-btn.active').dataset.index,'5');assert.equal(h.el(kind==='chat'?'studentChatTab':'studentTweetsTab').getAttribute('aria-selected'),'true');assert.equal(h.requests.find(r=>r.action==='getStudentSocial').channel,kind);assert.deepEqual(h.errors,[]);}finally{h.close();}}
});
test('supervisor chat notification selects requested stage and group before first read',async()=>{
 const h=await setup('supervisor','notify=chat&stage=secondary&group='+group);try{assert.equal(h.el('socialStage').value,'ثانوي');assert.equal(h.el('socialGroup').value,group);assert.equal(h.el('socialChats').getAttribute('aria-selected'),'true');const read=h.requests.find(r=>r.action==='getSupervisorSocial');assert.equal(read.stage,'ثانوي');assert.equal(read.groupId,group);assert.deepEqual(h.errors,[]);h.el('pushOpenBtn').click();assert.match(h.dom.window.document.querySelector('.push-description').textContent,/جميع المراحل/);}finally{h.close();}
});
