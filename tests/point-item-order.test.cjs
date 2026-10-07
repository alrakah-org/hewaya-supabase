const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{stripTypeScriptTypes}=require('node:module');
const html=fs.readFileSync(process.env.SUPERVISOR_HTML||__dirname+'/../apps/supervisor/index.html','utf8');
let stage='middle',calls=[],result={success:true},items=[{key:'a',label:'أ',active:true,points:100,maxChecks:1},{key:'b',label:'ب',active:false,points:200,maxChecks:2}];
const els={};function el(id){return els[id]||(els[id]={disabled:false,innerHTML:'',textContent:'',classList:{add(){},remove(){}},addEventListener(t,fn){this[t]=fn;}});}
const select=el('stage');Object.defineProperty(select,'value',{get:()=>stage});
const context={achievementStageSelect:select,achievementItemsLoadId:0,achievementItemsAdminCache:[],document:{getElementById:el,querySelectorAll:()=>[]},escapePointText:s=>s,achievementMessage:()=>{},callAppsScript:async p=>{calls.push(p);return p.action==='getAchievementItems'?{success:true,stage:p.stage,items}:result;},resetAchievementItemForm(){},window:{scrollTo(){}}};vm.createContext(context);
const load=html.slice(html.indexOf('async function loadAchievementItemsAdmin()'),html.indexOf('  achievementStageSelect.addEventListener'));
const handler=html.slice(html.indexOf("  document.getElementById('achievementItemsList').addEventListener"),html.indexOf("  document.getElementById('cancelAchievementItemEditBtn').addEventListener"));
vm.runInContext(load+handler,context);
(async()=>{
await context.loadAchievementItemsAdmin();assert.match(el('achievementItemsList').innerHTML,/data-direction="up"[^>]*disabled/);assert.match(el('achievementItemsList').innerHTML,/data-direction="down"[^>]*disabled/);
const btn={dataset:{moveAchievement:'b',direction:'up'}};
await el('achievementItemsList').click({target:{closest:()=>btn}});
assert.equal(calls.find(p=>p.action==='moveAchievementItem').stage,'middle');assert.equal(calls.find(p=>p.action==='moveAchievementItem').key,'b');assert.equal(select.disabled,false);
result={success:false,error:'failed'};await el('achievementItemsList').click({target:{closest:()=>btn}});assert.equal(select.disabled,false);
stage='';const n=calls.length;await el('achievementItemsList').click({target:{closest:()=>btn}});assert.equal(calls.length,n);
const edge=fs.readFileSync(process.env.ITEMS_EDGE||__dirname+'/../supabase/functions/hawaya-items/index.ts','utf8');
let serve,fetchCalls=[],rpcResult={success:true};const c={Request,Response,TextEncoder,Uint8Array,crypto:require('node:crypto').webcrypto,console,Deno:{env:{get:k=>k==='SUPABASE_URL'?'https://test.invalid':'server-only'},serve:fn=>serve=fn},fetch:async(url,o)=>{fetchCalls.push({url,o});return new Response(JSON.stringify(rpcResult));}};vm.createContext(c);vm.runInContext(stripTypeScriptTypes(edge),c);
const req=(p,token='fixture')=>new Request('https://test.invalid',{method:'POST',headers:{'Content-Type':'application/json',...(token?{'x-hawaya-session':token}:{})},body:JSON.stringify(p)});
assert.equal((await serve(req({action:'moveAchievementItem',stage:'middle',key:'b',direction:'up'},''))).status,401);assert.equal(fetchCalls.length,0);
assert.equal((await serve(req({action:'moveAchievementItem',stage:'bad',key:'b',direction:'up'}))).status,400);assert.equal(fetchCalls.length,0);
const r=await serve(req({action:'moveAchievementItem',stage:'middle',key:'b',direction:'up'}));assert.equal((await r.json()).success,true);const payload=JSON.parse(fetchCalls[0].o.body);assert.equal(payload.p_stage,'middle');assert.equal(payload.p_direction,'up');assert.equal(payload.p_token_hash.length,64);
rpcResult={success:false,error:'invalid session'};assert.equal((await (await serve(req({action:'moveAchievementItem',stage:'middle',key:'b',direction:'down'}))).json()).success,false);
console.log('PASS: arrow boundaries, scoped save, failure recovery, no-stage guard, endpoint validation and session rejection');
})().catch(e=>{console.error(e);process.exitCode=1;});