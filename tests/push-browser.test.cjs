const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const script=fs.readFileSync(__dirname+'/../apps/shared/notifications.js','utf8');
const worker=fs.readFileSync(__dirname+'/../apps/shared/push-worker.js','utf8');
const scope='/hewaya-supabase/apps/student/',base='https://alrakah-org.github.io'+scope;
const tick=()=>new Promise(r=>setImmediate(r));
async function settle(){for(let i=0;i<5;i++)await tick();}
function setup({saved=null,permission='default',ios=false,fail=false,delay=false,role='student',authenticated=true,unsupported=false}={}){
 const dom=new JSDOM('<button id="pushOpenBtn">bell</button>',{url:base.replace('/student/','/'+role+'/'),runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 let stored=saved?structuredClone(saved):null,session=authenticated?{id:'fixture',pw:'synthetic-password'}:null,permissionCalls=0,unsubscribed=0,closed=0,registered=0,sub=null,pending,visibility='visible';
 Object.defineProperty(w.document,'visibilityState',{get:()=>visibility});
 const requests=[];w.matchMedia=()=>({matches:false});
 if(ios)Object.defineProperty(w.navigator,'userAgent',{value:'iPhone'});
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
 w.HawayaPushStore={get:async()=>stored?structuredClone(stored):null,set:async(_,value)=>{stored=structuredClone(value);}};
 w.hawayaPushConfig={role,apiKey:'public-fixture',sessionKey:'fixture-session',session:()=>session,loggedIn:()=>!!session};
 w.Notification={permission,requestPermission:async()=>{permissionCalls++;w.Notification.permission='granted';return 'granted';}};w.PushManager=function(){};
 const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/fixture',toJSON(){return{endpoint:this.endpoint,keys:{p256dh:'fixture',auth:'fixture'}};},async unsubscribe(){sub=null;unsubscribed++;return true;}};
 if(saved?.enabled)sub=subscription;
 const reg={active:true,pushManager:{getSubscription:async()=>sub,subscribe:async()=>{sub=subscription;return sub;}},getNotifications:async()=>[{close(){closed++;}}]};
 Object.defineProperty(w.navigator,'serviceWorker',{value:{register:async()=>{registered++;return reg;},getRegistration:async()=>reg,ready:Promise.resolve(reg),addEventListener(){}}});
 w.fetch=async(_,options)=>{const body=JSON.parse(options.body);requests.push(body);if(fail&&body.action==='subscribe')throw new Error('offline');
  if(delay&&body.action==='subscribe')return new Promise(resolve=>{pending=()=>resolve({ok:true,json:async()=>({success:true,binding:'new-binding'})});});
  return{ok:true,json:async()=>body.action==='getPushConfig'?{success:true,publicKey:Buffer.alloc(65,1).toString('base64url')}:{success:true,binding:'new-binding'}};
 };
 if(unsupported){delete w.PushManager;delete w.Notification;}
 w.eval(script);
 return{w,requests,get saved(){return stored;},get prompts(){return permissionCalls;},get unsubscribed(){return unsubscribed;},get closed(){return closed;},get registrations(){return registered;},get showing(){return w.document.querySelector('.push-dialog').open;},setSession(value){session=value;},setVisibility(value){visibility=value;w.document.dispatchEvent(new w.Event('visibilitychange'));},dismiss:()=>w.document.querySelector('.push-close').click(),resolve(){pending();},toggle:()=>w.document.querySelector('.push-toggle').onclick(),open:()=>w.document.getElementById('pushOpenBtn').click(),close:()=>w.close()};
}
const enabled={enabled:true,binding:'old-binding',owner:'student:fixture',deviceToken:'a'.repeat(64),endpoint:'https://fcm.googleapis.com/fcm/send/fixture'};
test('login never prompts; explicit enable subscribes and stores no application credential',async()=>{
 const h=setup();try{await settle();assert.equal(h.prompts,0);assert.equal(h.registrations,0);h.open();await h.toggle();assert.equal(h.prompts,1);assert.equal(h.saved.enabled,true);assert.equal(h.saved.binding,'new-binding');assert.equal(JSON.stringify(h.saved).includes('synthetic-password'),false);assert.equal(h.requests.find(r=>r.action==='subscribe').password,'synthetic-password');}finally{h.close();}
});
test('previously enabled subscriptions refresh without another permission prompt',async()=>{
 const h=setup({saved:enabled,permission:'granted'});try{await settle();assert.equal(h.prompts,0);assert.equal(h.saved.binding,'new-binding');assert.equal(h.saved.enabled,true);assert.equal(h.showing,false);h.setVisibility('hidden');h.setVisibility('visible');await settle();assert.equal(h.showing,false);}finally{h.close();}
});
test('network failure during refresh preserves the working binding and allows disable',async()=>{
 const h=setup({saved:enabled,permission:'granted',fail:true});try{await settle();assert.equal(h.saved.enabled,true);assert.equal(h.saved.binding,'old-binding');await h.toggle();assert.equal(h.saved.enabled,false);assert.equal(h.unsubscribed,1);assert.ok(h.requests.some(r=>r.action==='unsubscribe'));}finally{h.close();}
});
test('denied browser and iPhone outside home screen show instructions without prompting',async()=>{
 for(const options of [{permission:'denied'},{ios:true,unsupported:true}]){const h=setup(options);try{await settle();assert.equal(h.showing,true);assert.equal(h.w.document.querySelector('.push-toggle').disabled,true);assert.equal(h.prompts,0);assert.match(h.w.document.querySelector('.push-status').textContent,options.ios?/الشاشة الرئيسية/:/محظورة/);}finally{h.close();}}
});
test('both roles are reminded once per visit and again on reopening without native prompts',async()=>{
 for(const role of ['student','supervisor']){
  const h=setup({role});try{
   await settle();assert.equal(h.showing,true);assert.equal(h.prompts,0);assert.equal(h.requests.length,0);
   h.dismiss();await h.w.hawayaPush.onLogin();assert.equal(h.showing,false);
   h.setVisibility('hidden');h.setVisibility('visible');await settle();assert.equal(h.showing,true);assert.equal(h.prompts,0);assert.equal(h.requests.length,0);
  }finally{h.close();}
  const reopened=setup({role});try{await settle();assert.equal(reopened.showing,true);assert.equal(reopened.prompts,0);}finally{reopened.close();}
 }
});
test('a reminder waits for login and for the app to become visible',async()=>{
 const h=setup({authenticated:false});try{
  await settle();assert.equal(h.showing,false);h.setVisibility('hidden');h.setSession({id:'fixture',pw:'synthetic-password'});
  await h.w.hawayaPush.onLogin();assert.equal(h.showing,false);h.setVisibility('visible');await settle();assert.equal(h.showing,true);assert.equal(h.prompts,0);
 }finally{h.close();}
});
test('enabling stops reminders across returns and relaunches for either role',async()=>{
 for(const role of ['student','supervisor']){
  const h=setup({role});let saved;try{
   await settle();await h.toggle();saved=h.saved;assert.equal(saved.enabled,true);h.dismiss();const count=h.requests.length;
   h.setVisibility('hidden');h.setVisibility('visible');await settle();assert.equal(h.showing,false);assert.equal(h.requests.length,count);assert.equal(h.prompts,1);
  }finally{h.close();}
  const reopened=setup({role,saved,permission:'granted'});try{await settle();assert.equal(reopened.showing,false);assert.equal(reopened.prompts,0);}finally{reopened.close();}
 }
});
test('failed activation continues reminders without repeating the native permission prompt',async()=>{
 const h=setup({fail:true});try{
  await settle();await h.toggle();assert.equal(h.saved.enabled,false);h.dismiss();h.setVisibility('hidden');h.setVisibility('visible');await settle();assert.equal(h.showing,true);assert.equal(h.prompts,1);
 }finally{h.close();}
});
test('revoked browser permission returns to the reminder with settings instructions',async()=>{
 const h=setup({saved:enabled,permission:'denied'});try{await settle();assert.equal(h.saved.enabled,false);assert.equal(h.showing,true);assert.equal(h.prompts,0);assert.match(h.w.document.querySelector('.push-status').textContent,/محظورة/);}finally{h.close();}
});
test('logout disables local deliveries, revokes the server capability and closes notifications',async()=>{
 const h=setup({saved:enabled,permission:'granted'});try{await settle();await h.w.hawayaPush.disconnect();assert.equal(h.saved.enabled,false);assert.equal(h.saved.binding,null);assert.ok(h.unsubscribed>0);assert.ok(h.closed>0);assert.ok(h.requests.some(r=>r.action==='unsubscribe'&&r.deviceToken===enabled.deviceToken));}finally{h.close();}
});
test('another account and cross-tab logout cannot inherit previous notifications',async()=>{
 const changed=setup({saved:{...enabled,owner:'student:someone-else'},permission:'granted'});try{await settle();assert.equal(changed.saved.enabled,false);assert.equal(changed.requests.some(r=>r.action==='subscribe'),false);}finally{changed.close();}
 const h=setup({saved:enabled,permission:'granted'});try{await settle();h.setSession(null);h.w.dispatchEvent(new h.w.StorageEvent('storage',{key:'fixture-session'}));await settle();assert.equal(h.saved.enabled,false);}finally{h.close();}
});
test('late subscription response after logout cannot reenable notifications',async()=>{
 const h=setup({permission:'granted',delay:true});try{await settle();const enabling=h.toggle();await settle();await h.w.hawayaPush.disconnect();h.setSession(null);h.resolve();await enabling;assert.equal(h.saved.enabled,false);assert.equal(h.saved.binding,null);assert.ok(h.requests.filter(r=>r.action==='unsubscribe').length>=2);}finally{h.close();}
});
function workerSetup(saved=enabled){
 const events={},shown=[],opened=[],navigated=[];let current=saved;
 const self={registration:{scope:base,showNotification:async(...args)=>shown.push(args)},location:{origin:'https://alrakah-org.github.io'},clients:{matchAll:async()=>[{url:base+'?old=1',navigate:async url=>{navigated.push(url);return{focus:async()=>{}};}}],openWindow:async url=>opened.push(url)},addEventListener:(name,fn)=>events[name]=fn};
 vm.runInNewContext(worker,{self,URL,importScripts(){},HawayaPushStore:{get:async()=>current}});
 return{shown,opened,navigated,setSaved:v=>current=v,emit:async(name,data)=>{let task;events[name]({...data,waitUntil:p=>task=p});await task;}};
}
test('worker displays correct binding only; stale accounts, disabled devices and foreign URLs ignored',async()=>{
 const h=workerSetup(),payload={title:'تعديل النقاط',body:'افتح التطبيق',binding:'old-binding',url:base+'?notify=points',tag:'job'};
 await h.emit('push',{data:{json:()=>payload}});assert.equal(h.shown.length,1);assert.equal(h.shown[0][1].dir,'rtl');
 for(const invalid of [{...payload,binding:'different'},{...payload,url:'https://evil.example/'},{...payload,url:base.replace('/student/','/supervisor/')}])await h.emit('push',{data:{json:()=>invalid}});
 h.setSaved({...enabled,enabled:false});await h.emit('push',{data:{json:()=>payload}});assert.equal(h.shown.length,1);
});
test('notification click focuses exact app destination; revoked binding never opens it',async()=>{
 const h=workerSetup(),url=base+'?notify=chat',notification={close(){},data:{url,binding:'old-binding'}};
 await h.emit('notificationclick',{notification});assert.deepEqual(h.navigated,[url]);h.setSaved({...enabled,binding:null});await h.emit('notificationclick',{notification});assert.equal(h.navigated.length,1);
});
