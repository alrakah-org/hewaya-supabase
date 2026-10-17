(function(){
  'use strict';
  const config=window.hawayaPushConfig;if(!config)return;
  const scope=new URL('.',location.href).pathname,store=window.HawayaPushStore;
  const api='https://uvcotcfemolqwkgypyeq.supabase.co/functions/v1/hawaya-push';
  let busy=false,syncTask=null,run=0,enabled=false;
  const dialog=document.createElement('dialog');dialog.className='push-dialog';dialog.dir='rtl';
  dialog.innerHTML='<h2>إشعارات هواية</h2><p class="push-description"></p><button type="button" class="push-toggle">تفعيل الإشعارات</button><p class="push-status" role="status" aria-live="polite"></p><button type="button" class="push-close">إغلاق</button>';
  document.body.appendChild(dialog);
  const toggle=dialog.querySelector('.push-toggle'),status=dialog.querySelector('.push-status');
  dialog.querySelector('.push-description').textContent=config.role==='student'?'تنبّهك عند تعديل نقاطك، ونشر تغريدة في مرحلتك، ووصول رسالة في مجموعتك.':'تنبّهك بالتغريدات ورسائل المجموعات في جميع المراحل.';
  dialog.querySelector('.push-close').onclick=()=>dialog.close();
  const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  const supported=()=>('serviceWorker'in navigator)&&('PushManager'in window)&&('Notification'in window)&&!!store;
  const owner=()=>{const s=config.session();return s?(config.role+':'+String(s.id||s.name||'')):'';};
  function draw(message){
    toggle.disabled=busy;
    toggle.textContent=busy?'جاري الإعداد...':enabled?'إيقاف الإشعارات':'تفعيل الإشعارات';
    if(message!==undefined)status.textContent=message;
    if(ios&&!standalone){toggle.disabled=true;status.textContent='أضف هواية إلى الشاشة الرئيسية من زر المشاركة في Safari، ثم افتحه من الأيقونة لتفعيل الإشعارات.';}
    else if(!supported()){toggle.disabled=true;status.textContent='هذا المتصفح لا يدعم إشعارات التطبيق. جرّب متصفحًا حديثًا.';}
    else if(Notification.permission==='denied'){toggle.disabled=true;status.textContent='الإشعارات محظورة. اسمح بها لهواية من إعدادات المتصفح أو الجهاز ثم أعد فتح التطبيق.';}
  }
  async function request(body,session,keepalive=false){
    const headers={'Content-Type':'application/json',apikey:config.apiKey,Authorization:'Bearer '+config.apiKey};
    if(session&&config.role==='supervisor')headers['x-hawaya-session']=session.token;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetch(api,{method:'POST',headers,body:JSON.stringify(body),keepalive,signal:controller.signal});
      const data=await response.json();if(!response.ok||!data.success)throw new Error(data.error||'تعذر إعداد الإشعارات. حاول مرة أخرى.');return data;
    }finally{clearTimeout(timer);}
  }
  async function registration(){
    const reg=await navigator.serviceWorker.register('sw.js?v=push-20261015',{scope:'./',updateViaCache:'none'});
    if(!reg.active)await navigator.serviceWorker.ready;
    return reg;
  }
  function decodeKey(value){const text=atob(value.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(text,c=>c.charCodeAt(0));}
  function token(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');}
  async function disconnect(){
    run++;enabled=false;
    const saved=await store?.get(scope).catch(()=>null);
    if(saved)await store.set(scope,{...saved,enabled:false,binding:null}).catch(()=>{});
    draw();
    const cleanup=[];
    if(saved?.endpoint&&saved.deviceToken)cleanup.push(request({action:'unsubscribe',endpoint:saved.endpoint,deviceToken:saved.deviceToken},null,true).catch(()=>{}));
    if('serviceWorker'in navigator)cleanup.push(navigator.serviceWorker.getRegistration(scope).then(async reg=>{
      const subscription=await reg?.pushManager?.getSubscription();if(subscription)await subscription.unsubscribe();
      for(const notification of await reg?.getNotifications()||[])notification.close();
    }).catch(()=>{}));
    await Promise.race([Promise.allSettled(cleanup),new Promise(resolve=>setTimeout(resolve,2000))]);
  }
  async function subscribe(){
    const version=++run,session=config.session(),currentOwner=owner();if(!session)throw new Error('سجّل الدخول أولًا.');
    const reg=await registration();let saved=await store.get(scope);
    const data=await request({action:'getPushConfig'});
    let subscription=await reg.pushManager.getSubscription();
    if(subscription&&!saved?.deviceToken){await subscription.unsubscribe();subscription=null;}
    if(!subscription)subscription=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodeKey(data.publicKey)});
    if(version!==run||owner()!==currentOwner){await subscription.unsubscribe();return;}
    const deviceToken=saved?.deviceToken||token();
    // Preserve a working binding during refresh; retain the capability if a new
    // registration loses its response so logout can still revoke it.
    const previous=saved?.owner===currentOwner&&saved.endpoint===subscription.endpoint?saved:null;
    saved={enabled:!!previous?.enabled,binding:previous?.binding||null,owner:currentOwner,deviceToken,endpoint:subscription.endpoint};
    await store.set(scope,saved);
    const auth=config.role==='student'?{id:String(session.id),password:String(session.pw)}:{};
    const result=await request({action:'subscribe',role:config.role,subscription:subscription.toJSON(),deviceToken,...auth},session);
    if(version!==run||owner()!==currentOwner){await request({action:'unsubscribe',endpoint:subscription.endpoint,deviceToken},null,true).catch(()=>{});return;}
    await store.set(scope,{...saved,enabled:true,binding:result.binding});enabled=true;
    draw('الإشعارات مفعّلة على هذا الجهاز.');
  }
  async function onLogin(){
    if(!supported())return;
    if(!owner()){await disconnect();return;}
    if(!config.loggedIn())return;
    if(syncTask)return syncTask;
    syncTask=(async()=>{
      const saved=await store.get(scope);
      if(saved?.owner&&saved.owner!==owner()){await disconnect();return;}
      enabled=!!saved?.enabled;draw();
      if(enabled&&Notification.permission==='granted')await subscribe();
      else if(enabled)await disconnect();
    })().catch(()=>{draw('تعذر تحديث اشتراك الإشعارات. افتح هذه النافذة وأعد التفعيل.');}).finally(()=>{syncTask=null;});
    return syncTask;
  }
  toggle.onclick=async()=>{
    if(busy||!supported())return;
    busy=true;draw('');
    try{
      if(enabled){await disconnect();draw('تم إيقاف الإشعارات على هذا الجهاز.');}
      else{
        // Permission is requested directly from the user's click, never on login.
        const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();
        if(permission!=='granted'){draw(permission==='denied'?'الإشعارات محظورة من إعدادات الجهاز.':'لم يتم تفعيل الإشعارات.');return;}
        await subscribe();
      }
    }catch(error){draw(error.message||'تعذر إعداد الإشعارات. حاول مرة أخرى.');}
    finally{busy=false;draw();}
  };
  document.getElementById('pushOpenBtn')?.addEventListener('click',async()=>{
    draw();dialog.showModal();
    try{const saved=await store?.get(scope);enabled=!!saved?.enabled&&saved.owner===owner();draw();}catch{draw('تعذر حفظ إعدادات الإشعارات على هذا الجهاز.');}
  });
  window.hawayaPush={onLogin,disconnect};
  navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='HAWAYA_PUSH_RENEW')onLogin();});
  window.addEventListener('storage',event=>{if(event.key===config.sessionKey)onLogin();});
  if(config.loggedIn()||!owner())onLogin();
})();
