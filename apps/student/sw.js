importScripts('../shared/push-worker.js?v=20261015');
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>event.respondWith(fetch(event.request,event.request.mode==='navigate'?{cache:'no-cache'}:undefined)));
