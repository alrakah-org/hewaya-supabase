const {JSDOM,VirtualConsole}=require(process.env.JSDOM_PATH||'jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.env.STUDENT_HTML||__dirname+'/../apps/student/index.html','utf8');
const requests=[],errors=[];
let messages=[{id:'tweet-1',name:'مشرف',text:'تغريدة مثبتة',supervisor:true,pinned:true,liked:false,likes:0,createdAt:'2026-10-06T08:00:00Z'}];
const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
const dom=new JSDOM(source,{url:'https://alrakah-org.github.io/hewaya-supabase/apps/student/',runScripts:'dangerously',virtualConsole:vc,beforeParse(w){
 w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});
 w.localStorage.setItem('hawaya_student_session',JSON.stringify({id:'fixture-student',pw:'fixture-password'}));
 w.fetch=async(url,options)=>{const p=JSON.parse(options.body);requests.push({url,p});
 let data={success:true,items:[],announcements:[],logs:[]};
 if(p.action==='studentLogin')data={success:true,id:p.id,name:'طالب اختبار',stage:'المرحلة المتوسطة',balance:0};
 if(['getStudentSocial','postStudentSocial','setStudentSocialLike'].includes(p.action)){
 if(p.action==='postStudentSocial')messages=[{id:p.messageId,name:'طالب اختبار',text:p.text,mine:true,createdAt:new Date().toISOString()},...messages];
 if(p.action==='setStudentSocialLike')messages=messages.map(m=>m.id===p.messageId?{...m,liked:p.liked,likes:p.liked?1:0}:m);
 data={success:true,enabled:true,hasGroup:true,stageLabel:'المرحلة المتوسطة',groupName:'مجموعتي',messages:p.channel==='chat'?[]:messages};}
 return{ok:true,json:async()=>data};};
 w.HTMLMediaElement.prototype.play=async()=>{};w.HTMLMediaElement.prototype.pause=()=>{};
}});
const settle=()=>new Promise(r=>setTimeout(r,30));
(async()=>{try{
 await settle();const w=dom.window,d=w.document;
 assert.equal(d.getElementById('studentSocialStage').textContent,'المرحلة المتوسطة');
 assert.equal(d.getElementById('studentSocialForm').classList.contains('hidden'),false);
 assert.match(d.getElementById('studentSocialFeed').textContent,/تغريدة مثبتة/);
 d.getElementById('studentSocialText').value='تغريدة اختبار';await d.getElementById('studentSocialForm').onsubmit({preventDefault(){}});
 assert.match(d.getElementById('studentSocialFeed').textContent,/تغريدة اختبار/);
 const like=d.querySelector('[data-like="tweet-1"]');await d.getElementById('studentSocialFeed').onclick({target:like});
 assert.equal(d.querySelector('[data-like="tweet-1"]').getAttribute('aria-pressed'),'true');
 d.getElementById('studentChatTab').click();await settle();
 assert.equal(d.getElementById('studentSocialFeed').nextElementSibling.id,'studentSocialForm');
 d.getElementById('studentTweetsTab').click();await settle();
 assert.equal(d.getElementById('studentSocialForm').nextElementSibling.id,'studentSocialFeedTitle');
 const social=requests.filter(r=>r.p.action.includes('Social'));assert.ok(social.length>=5);
 for(const r of social){assert.match(r.url,/\/hawaya-social$/);assert.equal(r.p.id,'fixture-student');assert.equal(r.p.password,'fixture-password');}
 assert.deepEqual(errors,[]);console.log('PASS: full student startup, feed, publish, like, group chat, composer placement and authenticated routing');
 }finally{dom.window.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
