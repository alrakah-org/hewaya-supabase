/**
 * Service Worker بسيط لتطبيق "هواية الصيفي" - الطالب.
 * وظيفته الوحيدة حاليًا: تحقيق الشرط الفني الذي تطلبه المتصفحات (مثل كروم
 * على أندرويد) لتفعيل التثبيت التلقائي للتطبيق (PWA) — بدون أي تخزين مؤقت
 * فعلي للملفات (كل طلب يمر مباشرة للشبكة كالعادة). يمكن تطويره لاحقًا
 * لإضافة عمل بدون إنترنت (offline) لو احتجت ذلك.
 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // تمرير كل الطلبات للشبكة مباشرة بدون أي تخزين مؤقت
  event.respondWith(fetch(event.request));
});
