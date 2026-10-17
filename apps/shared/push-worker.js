/* Runs in each application's own service-worker scope. */
importScripts('../shared/push-store.js?v=20261015');
const PUSH_SCOPE=new URL(self.registration.scope).pathname;
function safeNotificationUrl(value){
  try{const url=new URL(value);return url.origin===self.location.origin&&!url.username&&!url.password&&url.pathname===PUSH_SCOPE?url.href:null;}catch{return null;}
}
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let payload;try{payload=event.data?.json();}catch{return;}
    if(!payload||typeof payload.title!=='string')return;
    const saved=await HawayaPushStore.get(PUSH_SCOPE);
    // A delayed delivery for a previous login must never reach the new account.
    if(!saved?.enabled||saved.binding!==payload.binding)return;
    const url=safeNotificationUrl(payload.url);if(!url)return;
    await self.registration.showNotification(payload.title.slice(0,100),{
      body:String(payload.body||'').slice(0,250),dir:'rtl',lang:'ar',
      icon:new URL('icon-192.png',self.registration.scope).href,
      badge:new URL('icon-192.png',self.registration.scope).href,
      tag:String(payload.tag||'hawaya').slice(0,100),renotify:false,
      data:{url,binding:payload.binding}
    });
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const saved=await HawayaPushStore.get(PUSH_SCOPE);
    if(!saved?.enabled||saved.binding!==event.notification.data?.binding)return;
    const url=safeNotificationUrl(event.notification.data?.url);if(!url)return;
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(client=>new URL(client.url).pathname.startsWith(PUSH_SCOPE));
    if(existing){const navigated=await existing.navigate(url);await (navigated||existing).focus();}
    else await self.clients.openWindow(url);
  })());
});
self.addEventListener('pushsubscriptionchange',event=>{
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows)if(new URL(client.url).pathname.startsWith(PUSH_SCOPE))client.postMessage({type:'HAWAYA_PUSH_RENEW'});
  })());
});
