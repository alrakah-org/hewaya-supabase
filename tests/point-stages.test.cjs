const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {stripTypeScriptTypes}=require('node:module');
const {webcrypto}=require('node:crypto');
const source=stripTypeScriptTypes(fs.readFileSync(__dirname+'/../supabase/functions/hawaya-api/index.ts','utf8'));
function setup(){
  const stages=['elementary_456','middle','secondary'];
  const items=stages.map((stage,i)=>({id:`item-${i}`,code:i?'lesson__'+stage:'lesson',base_code:'lesson',stage_category:stage,name:'الدرس '+stage,points_per_mark:100*(i+1),max_marks:5,limit_period:'weekly',active:true,allowed_weekdays:[0,2],sort_order:20}));
  const students=stages.map((stage,i)=>({id:i+1,student_code:'student-'+stage,grade:['رابع ابتدائي','أول متوسط','أول ثانوي'][i]}));
  const awards=[{student_id:2,point_item_id:'item-1',quantity:2,week_number:6,point_items:{code:'lesson__middle',base_code:'lesson'}}];
  const writes=[];let handler, emptyPatch=false;
  const mockFetch=async(url,init={})=>{
    const u=new URL(url), table=u.pathname.split('/').pop(), q=u.searchParams, method=init.method||'GET';
    if(u.pathname.includes('/rpc/')){
      const p=JSON.parse(init.body);
      if(table==='edge_student_verify')return new Response(JSON.stringify(students.find(s=>s.student_code===p.p_code&&p.p_password==='test')?.id||null));
      if(table==='edge_supervisor_session')return new Response(JSON.stringify([{supervisor_name:'test'}]));
    }
    let data=table==='point_items'?items:table==='students'?students:table==='point_awards'?awards:[];
    for(const [k,v] of q){if(v.startsWith('eq.'))data=data.filter(x=>String(x[k])===v.slice(3));if(v==='is.null')data=data.filter(x=>x[k]==null);}
    if(method==='PATCH'){const payload=JSON.parse(init.body);writes.push({table,data,payload});if(emptyPatch)return new Response('[]');data.forEach(x=>Object.assign(x,payload));}
    if(method==='POST'){const payload=JSON.parse(init.body);const row={id:'created-'+writes.length,...payload};writes.push({table,payload});(table==='point_items'?items:awards).push(row);data=[row];}
    return new Response(JSON.stringify(data));
  };
  class FixedDate extends Date { constructor(...args){super(...(args.length?args:['2026-10-04T16:30:00Z']));} static now(){return new Date('2026-10-04T16:30:00Z').getTime();} }
  vm.runInNewContext(source,{Deno:{env:{get:n=>n==='SUPABASE_URL'?'https://test.supabase.co':'test'},serve:h=>handler=h},fetch:mockFetch,Response,Headers,Request,TextEncoder,crypto:webcrypto,console,Date:FixedDate,setTimeout});
  return {items,awards,writes,setEmptyPatch(){emptyPatch=true;},async call(body,admin=true){const response=await handler(new Request('https://test/api',{method:'POST',headers:admin?{'x-hawaya-session':'test'}:{},body:JSON.stringify(body)}));return {status:response.status,...await response.json()};}};
}
test('admin must choose a stage and stage lists are isolated',async()=>{const x=setup();assert.equal((await x.call({action:'getAchievementItems'})).success,false);for(const stage of ['elementary_456','middle','secondary']){const r=await x.call({action:'getAchievementItems',stage});assert.equal(r.success,true);assert.equal(r.items.length,1);assert.equal(r.items[0].stage,stage);}});
test('nested item edits persist and preserve weekdays and activation',async()=>{const x=setup();x.items[1].active=false;const r=await x.call({action:'saveAchievementItem',stage:'middle',item:{key:'lesson__middle',label:'تعديل المتوسط',points:777,maxChecks:4}});assert.equal(r.success,true);assert.equal(r.item.points,777);assert.equal(r.item.active,false);assert.deepEqual(r.item.allowedWeekdays,[0,2]);assert.equal(x.items[0].points_per_mark,100);assert.equal(x.items[2].points_per_mark,300);});
test('cross-stage edit and toggle are rejected without changing other items',async()=>{const x=setup();assert.equal((await x.call({action:'saveAchievementItem',stage:'secondary',item:{key:'lesson__middle',label:'خطأ',points:5,maxChecks:1}})).success,false);assert.equal((await x.call({action:'toggleAchievementItem',stage:'secondary',key:'lesson__middle',active:false})).success,false);assert.equal(x.items[1].active,true);});
test('zero-row patch cannot report a successful save',async()=>{const x=setup();x.setEmptyPatch();assert.equal((await x.call({action:'saveAchievementItem',stage:'middle',item:{key:'lesson__middle',label:'الدرس',points:200,maxChecks:5}})).success,false);});
test('student stage comes from the database and existing marks survive',async()=>{const x=setup();const r=await x.call({action:'getDayPointsContext',id:'student-middle',password:'test',stage:'secondary'},false);assert.equal(r.success,true);assert.equal(r.items.length,1);assert.equal(r.items[0].stage,'middle');assert.equal(r.items[0].count,2);assert.equal(r.items[0].points,200);});
test('student cannot award foreign items; legacy keys resolve only to own stage',async()=>{const x=setup();const r=await x.call({action:'saveDayPoints',id:'student-middle',password:'test',counts:{lesson__secondary:4}},false);assert.equal(r.success,false);assert.equal(x.writes.length,0);const saved=await x.call({action:'saveDayPoints',id:'student-middle',password:'test',counts:{lesson:3}},false);assert.equal(saved.success,true);const award=x.writes.find(x=>x.table==='point_awards').payload;assert.equal(award.point_item_id,'item-1');assert.equal(award.quantity,1);assert.equal(award.unit_points,200);});
test('create and disabling all items never expose a different stage',async()=>{const x=setup();const r=await x.call({action:'saveAchievementItem',stage:'secondary',item:{label:'خاص',points:99,maxChecks:3,active:false}});assert.equal(r.success,true);assert.equal(r.item.stage,'secondary');assert.equal(r.item.active,false);x.items.filter(i=>i.stage_category==='secondary').forEach(i=>i.active=false);assert.equal((await x.call({action:'getAchievementItems',stage:'secondary'})).items.length,0);});
function setupUI(api){
  const html=fs.readFileSync(__dirname+'/../apps/supervisor/index.html','utf8');
  const start=html.indexOf('  /* ==================== إدارة بنود النقاط حسب المرحلة');
  const end=html.indexOf('  // ترتيب صفحة الإعلانات:',start);
  const nodes=new Map(), calls=[];
  const get=id=>{if(!nodes.has(id)){const classes=new Set();nodes.set(id,{value:'',disabled:false,textContent:'',innerHTML:'',style:{},events:{},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},addEventListener(type,fn){this.events[type]=fn;}});}return nodes.get(id);};
  const context={document:{getElementById:get},window:{scrollTo(){}},callAppsScript:async p=>{calls.push(p);return api(p);}};
  vm.createContext(context);vm.runInContext(html.slice(start,end),context);
  return {get,calls,context};
}
test('UI requires a stage, sends nested edits with stage, and confirms fresh values',async()=>{
  let row={key:'lesson__middle',stage:'middle',label:'الدرس',points:200,maxChecks:5,active:true,order:20};
  const ui=setupUI(async p=>{if(p.action==='saveAchievementItem'){assert.equal(p.stage,'middle');assert.equal(p.item.stage,'middle');row={...row,...p.item};return {success:true,item:row};}return {success:true,stage:p.stage,items:[row]};});
  assert.equal(await ui.context.loadAchievementItemsAdmin(),false);assert.equal(ui.calls.length,0);
  ui.get('achievementStageSelect').value='middle';await ui.context.loadAchievementItemsAdmin();
  ui.get('achievementItemKey').value=row.key;ui.get('achievementItemLabel').value='اسم جديد';ui.get('achievementItemPoints').value='333';ui.get('achievementItemMaxChecks').value='4';
  await ui.get('saveAchievementItemBtn').events.click();
  assert.equal(row.label,'اسم جديد');assert.match(ui.get('achievementItemMsg').textContent,/تم حفظ البند/);assert.equal(ui.get('achievementStageSelect').disabled,false);
});
test('UI stage changes clear edits and late responses cannot overwrite new stage',async()=>{
  let resolveMiddle;
  const ui=setupUI(p=>p.stage==='middle'?new Promise(r=>resolveMiddle=r):Promise.resolve({success:true,stage:'secondary',items:[{key:'secondary',label:'الثانوي',points:100,maxChecks:1,active:true}]}));
  ui.get('achievementStageSelect').value='middle';const first=ui.context.loadAchievementItemsAdmin();
  ui.get('achievementItemKey').value='middle';ui.get('achievementItemLabel').value='edit';
  ui.get('achievementStageSelect').value='secondary';ui.get('achievementStageSelect').events.change();
  await new Promise(setImmediate);resolveMiddle({success:true,stage:'middle',items:[{key:'middle',label:'المتوسط'}]});await first;
  assert.equal(ui.get('achievementItemKey').value,'');assert.match(ui.get('achievementItemsList').innerHTML,/الثانوي/);assert.doesNotMatch(ui.get('achievementItemsList').innerHTML,/المتوسط/);
});
test('UI detects a save response that does not persist the edited values',async()=>{
  const row={key:'lesson__middle',label:'قديم',points:200,maxChecks:5,active:true,order:20};
  const ui=setupUI(async p=>p.action==='saveAchievementItem'?{success:true,key:row.key}:{success:true,stage:p.stage,items:[row]});
  ui.get('achievementStageSelect').value='middle';await ui.context.loadAchievementItemsAdmin();
  ui.get('achievementItemKey').value=row.key;ui.get('achievementItemLabel').value='جديد';ui.get('achievementItemPoints').value='300';ui.get('achievementItemMaxChecks').value='4';
  await ui.get('saveAchievementItemBtn').events.click();assert.match(ui.get('achievementItemMsg').textContent,/لم يظهر التعديل/);assert.equal(ui.get('achievementItemKey').value,row.key);
});
