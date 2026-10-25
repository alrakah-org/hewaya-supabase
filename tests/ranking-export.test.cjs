const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM,VirtualConsole}=require(process.env.JSDOM_PATH||'jsdom');
const exporter=require('../apps/supervisor/ranking-export.js');
const selection={stage:'متوسط',mode:'groups',weekLabel:'الأسبوع الرابع'};
const groups=[{name:'الإحسان',totalPoints:40,members:[{name:'سامي أحمد',balance:5},{name:'عبدالله محمد',balance:35}]},
  {name:'الإخلاص',totalPoints:80,members:[{name:'عمر خالد',balance:80}]}];
async function unzip(blob){
 const buf=Buffer.from(await blob.arrayBuffer()),files={};let pos=0;
 while(buf.readUInt32LE(pos)===0x04034b50){const size=buf.readUInt32LE(pos+18),n=buf.readUInt16LE(pos+26),e=buf.readUInt16LE(pos+28),start=pos+30+n+e;assert.equal(buf.readUInt16LE(pos+8),0);files[buf.toString('utf8',pos+30,pos+30+n)]=buf.toString('utf8',start,start+size);pos=start+size;}
 assert.equal(buf.readUInt32LE(pos),0x02014b50);return files;
}
test('group export includes a descending overview and every selected group member without mutating the response',()=>{
 const before=JSON.stringify(groups),r=exporter.createReport(groups,selection);
 assert.equal(JSON.stringify(groups),before);assert.equal(r.sections.length,3);
 assert.deepEqual(r.sections[0].rows.map(x=>[x.name,x.value]),[['الإخلاص',80],['الإحسان',40]]);
 assert.deepEqual(r.sections[2].rows.map(x=>x.value),[35,5]);assert.equal(r.week,selection.weekLabel);
});
test('150 students stay complete and descending across readable chart pages, including ties and negative points',()=>{
 const members=Array.from({length:150},(_,i)=>({name:'طالب '+i,balance:140-i}));
 const r=exporter.createReport([{name:'أفراد',totalPoints:1,members}],{...selection,mode:'individuals'}),pages=exporter.pages(r);
 assert.equal(pages.length,15);assert.equal(pages.flatMap(p=>p.rows).length,150);assert.equal(pages.at(-1).offset,140);
 assert.deepEqual(pages[0].scale,pages.at(-1).scale);assert.equal(r.sections[0].rows.at(-1).value,-9);
 assert.equal(exporter.pages(exporter.createReport([{members:[{name:'صفر',balance:0}],totalPoints:0}],{...selection,mode:'individuals'}))[0].scale.high,5);
});
test('XLSX contains native editable charts linked to numeric cells and preserves Arabic labels safely',async()=>{
 const r=exporter.createReport([{name:'الإحسان / 1',totalPoints:9,members:[{name:'=HYPERLINK("x") & <أحمد>',balance:9}]}],selection);
 const files=await unzip(exporter.xlsx(r));
 assert.ok(files['xl/charts/chart1.xml'].includes('<c:barDir val="col"/>'));
 assert.match(files['xl/charts/chart2.xml'],/\$B\$6:\$B\$6/);
 assert.match(files['xl/charts/chart2.xml'],/\$C\$6:\$C\$6/);
 assert.match(files['xl/worksheets/sheet2.xml'],/<c r="C6" s="0"><v>9<\/v>/);
 assert.match(files['xl/worksheets/sheet2.xml'],/t="inlineStr"/);assert.match(files['xl/worksheets/sheet2.xml'],/&amp; &lt;أحمد&gt;/);
 assert.doesNotMatch(files['xl/worksheets/sheet2.xml'],/<f>/);assert.match(files['xl/worksheets/sheet2.xml'],/rightToLeft="1"/);
 for(const [path,content]of Object.entries(files)){const doc=new JSDOM(content,{contentType:'text/xml'});assert.equal(doc.window.document.querySelector('parsererror'),null,path);doc.window.close();}
 assert.throws(()=>exporter.xlsx(exporter.createReport([],{...selection,mode:'individuals'})),/لا توجد نتائج/);
 assert.throws(()=>exporter.createReport([{totalPoints:NaN}],selection),/قيمة نقاط/);
});
const html=fs.readFileSync(__dirname+'/../apps/supervisor/index.html','utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){
 const pending=[],requests=[],downloads=[],errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(html,{url:'https://alrakah-org.github.io/hewaya-supabase/apps/supervisor/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
  w.TextEncoder=TextEncoder;w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});
  Object.defineProperty(w.crypto,'subtle',{value:require('node:crypto').webcrypto.subtle});
  w.localStorage.setItem('hawaya_supervisor_session',JSON.stringify({name:'فارس مقبول',token:'synthetic-test-only',expiresAt:'2030-01-01T00:00:00Z'}));
  w.HawayaRankingExport={...exporter,download:(blob,name)=>downloads.push({blob,name})};
  w.fetch=async(url,options)=>{const p=JSON.parse(options.body);requests.push(p);
   if(p.action==='getAdvancedRanking')return new Promise((resolve,reject)=>pending.push({p,resolve:data=>resolve({ok:true,json:async()=>data}),reject}));
   return {ok:true,json:async()=>({success:true,groups:[],weeks:[{value:'all',label:'كل الأسابيع'},{value:'4',label:'الأسبوع الرابع'}],students:[],items:[],announcements:[],logs:[]})};
  };
 }});
 const el=id=>dom.window.document.getElementById(id);
 const select=(id,value)=>{el(id).value=value;el(id).dispatchEvent(new dom.window.Event('change'));};
 const show=async()=>{el('showRankingBtn').click();await tick();return pending.shift();};
 return{dom,el,select,show,pending,requests,downloads,errors,close:()=>dom.window.close()};
}
test('displayed rankings download with the same stage and period; exporting performs no API request',async()=>{
 const h=setup();try{
  await tick();h.select('rankingModeSelect','individuals');
  const request=await h.show();request.resolve({success:true,columns:[{name:'أفراد',totalPoints:4,members:[{name:'طالب تجريبي',balance:4}]}],weekNumber:'all'});await tick();
  assert.equal(h.el('rankingExportPanel').classList.contains('hidden'),false);const before=h.requests.length;
  h.el('rankingExcelBtn').click();await tick();assert.equal(h.downloads.length,1);assert.equal(h.requests.length,before);
  assert.match(h.downloads[0].name,/كل الأسابيع/);assert.match(h.downloads[0].name,/\.xlsx$/);assert.deepEqual(h.errors,[]);
  h.el('rankingDetailsCheck').click();assert.equal(h.el('rankingExportPanel').classList.contains('hidden'),true);
  h.el('rankingExcelBtn').click();await tick();assert.equal(h.downloads.length,1);
 }finally{h.close();}
});
test('late rankings cannot replace a newer request or leak past logout',async()=>{
 const h=setup();try{
  await tick();const first=await h.show(),second=await h.show();
  second.resolve({success:true,columns:[{name:'الأحدث',totalPoints:10,members:[]}],weekNumber:'all'});await tick();
  first.resolve({success:true,columns:[{name:'قديم',totalPoints:1,members:[]}],weekNumber:'all'});await tick();
  assert.match(h.el('rankingColumns').textContent,/الأحدث/);assert.doesNotMatch(h.el('rankingColumns').textContent,/قديم/);
  const pending=await h.show();h.el('supervisorLogoutBtn').click();pending.resolve({success:true,columns:groups,weekNumber:'all'});await tick();
  assert.equal(h.el('rankingExportPanel').classList.contains('hidden'),true);assert.equal(h.el('rankingColumns').textContent,'');assert.deepEqual(h.errors,[]);
 }finally{h.close();}
});
test('group subset is sent accurately, empty selection is rejected, and hidden group selection does not restrict individuals',async()=>{
 const h=setup();try{
  await tick();h.el('rankingGroupChecks').innerHTML='<input id="rankingAllGroups" type="checkbox"><input class="ranking-group-check" type="checkbox" value="chosen" checked>';
  const request=await h.show();assert.deepEqual(request.p.groupIds,['chosen']);request.resolve({success:true,columns:groups,weekNumber:'all'});await tick();
  h.el('rankingGroupChecks').querySelector('.ranking-group-check').click();h.el('showRankingBtn').click();await tick();assert.equal(h.pending.length,0);assert.match(h.el('rankingColumns').textContent,/اختر مجموعة/);
  h.select('rankingModeSelect','individuals');const next=await h.show();assert.deepEqual(next.p.groupIds,[]);next.resolve({success:true,columns:[],weekNumber:'all'});await tick();
  assert.equal(h.el('rankingExportPanel').classList.contains('hidden'),true);
 }finally{h.close();}
});
test('week mismatch, empty data and failed loads never expose an export button',async()=>{
 const h=setup();try{
  await tick();h.el('rankingWeekFilters').innerHTML='<button class="ranking-week-btn" data-ranking-week="4">الأسبوع الرابع</button>';h.el('rankingWeekFilters').firstChild.click();
  const mismatch=await h.show();assert.equal(mismatch.p.weekNumber,'4');mismatch.resolve({success:true,columns:groups,weekNumber:'all'});await tick();assert.match(h.el('rankingColumns').textContent,/تعذر تطبيق/);assert.equal(h.el('rankingExportPanel').classList.contains('hidden'),true);
  const failure=await h.show();failure.reject(new Error('offline'));await tick();assert.equal(h.el('rankingExportPanel').classList.contains('hidden'),true);
  const empty=await h.show();empty.resolve({success:true,columns:[],weekNumber:'4'});await tick();assert.equal(h.el('rankingExportPanel').classList.contains('hidden'),true);
 }finally{h.close();}
});
