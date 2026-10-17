const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM,VirtualConsole}=require('jsdom');
const tick=()=>new Promise(r=>setImmediate(r));async function settle(){for(let i=0;i<5;i++)await tick();}
function setup(expired=false){
 const calls=[],errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(fs.readFileSync(__dirname+'/../apps/supervisor/index.html','utf8'),{url:'https://alrakah-org.github.io/hewaya-supabase/apps/supervisor/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
  w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});w.TextEncoder=TextEncoder;Object.defineProperty(w.crypto,'subtle',{value:crypto.subtle});w.setInterval=()=>1;
  w.localStorage.setItem('hawaya_supervisor_session',JSON.stringify({name:'فارس مقبول',token:'synthetic-session',expiresAt:'2030-01-01T00:00:00Z'}));
  w.fetch=async(_,options)=>{const p=JSON.parse(options.body);calls.push(p);if(expired&&p.action==='generatePreview')return{ok:false,status:401,json:async()=>({success:false,error:'انتهت الجلسة'})};
   const result=p.action==='generatePreview'?{success:true,id:'987654',password:'2468',name:p.name,stage:p.stage,imageUrl:''}:p.action==='confirmRegister'?{success:false,error:'synthetic save response'}:{success:true,items:[],announcements:[],logs:[]};
   return{ok:true,status:200,json:async()=>result};
  };
 }});
 const el=id=>dom.window.document.getElementById(id),submit=()=>el('registerForm').dispatchEvent(new dom.window.Event('submit',{cancelable:true,bubbles:true}));
 return{dom,el,submit,calls,errors,close:()=>dom.window.close()};
}
test('preview and confirmation remain usable if the optional QR renderer fails to load',async()=>{
 const h=setup();try{await settle();h.el('studentName').value='طالب الاختبار';h.el('studentStage').value='أول متوسط';h.submit();await settle();
  assert.equal(h.el('successView').classList.contains('hidden'),false);assert.match(h.el('qrcode').textContent,/رقم الطالب/);assert.equal(h.el('badgeId').textContent,'987654');h.el('confirmBtn').click();await settle();assert.equal(h.calls.filter(c=>c.action==='confirmRegister').length,1);assert.match(h.el('confirmErrorMsg').textContent,/synthetic save response/);assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});
test('expired registration session requests login and preserves the entered student details',async()=>{
 const h=setup(true);try{await settle();h.el('studentName').value='طالب الاختبار';h.el('studentStage').value='أول متوسط';h.submit();await settle();
  assert.equal(h.el('supervisorLoginView').classList.contains('hidden'),false);assert.match(h.el('supervisorLoginError').textContent,/انتهت جلسة/);assert.equal(h.el('studentName').value,'طالب الاختبار');assert.equal(h.el('studentStage').value,'أول متوسط');assert.equal(h.dom.window.localStorage.getItem('hawaya_supervisor_session'),null);assert.equal(h.calls.some(c=>c.action==='confirmRegister'),false);assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});
