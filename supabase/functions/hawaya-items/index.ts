declare const Deno: {env:{get(name:string):string|undefined};serve(handler:(req:Request)=>Promise<Response>):void};
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-hawaya-session','Access-Control-Allow-Methods':'POST,OPTIONS'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return json({});
 if(req.method!=='POST')return json({success:false,error:'طريقة غير مدعومة'},405);
 try{
 const body=await req.json(),token=req.headers.get('x-hawaya-session')||'';
 if(!token)return json({success:false,error:'انتهت الجلسة، سجل الدخول مجددًا'},401);
 if(body.action!=='moveAchievementItem'||!['elementary_456','middle','secondary'].includes(body.stage)||!['up','down'].includes(body.direction)||typeof body.key!=='string'||body.key.length>200)return json({success:false,error:'طلب غير صحيح'},400);
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
 const tokenHash=Array.from(new Uint8Array(hash)).map(x=>x.toString(16).padStart(2,'0')).join('');
 const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
 const response=await fetch(Deno.env.get('SUPABASE_URL')+'/rest/v1/rpc/edge_move_point_item',{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({p_token_hash:tokenHash,p_stage:body.stage,p_code:body.key,p_direction:body.direction})});
 if(!response.ok){console.error('point item reorder RPC failed',response.status);return json({success:false,error:'تعذر حفظ الترتيب. حاول مرة أخرى.'},500);}
 return json(await response.json());
 }catch{ return json({success:false,error:'تعذر حفظ الترتيب. حاول مرة أخرى.'},400); }
});