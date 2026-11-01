// Service worker for the grades dashboard: makes it installable and receives push notifications.
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const config = JSON.parse(new URL(self.location.href).searchParams.get('config') || '{}');
if (config.apiKey) {
  firebase.initializeApp(config);
  firebase.messaging(); // shows notifications while the app is closed and opens it on tap
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Page loads go to the network; if offline, show a simple message instead of Chrome's error page
const OFFLINE_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0F1012">
<title>Grades</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0F1012;color:#EDEDEF;font-family:system-ui,sans-serif;text-align:center;padding:24px">
<div><h1 style="font-size:24px;margin:0 0 8px">You're offline</h1>
<p style="color:#A1A2A8;margin:0 0 20px">Your grades will load when you're back online.</p>
<button onclick="location.reload()" style="font:inherit;font-weight:600;color:#fff;background:#4F8CFF;border:0;border-radius:999px;padding:12px 22px">Try again</button></div>
</body></html>`;

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() =>
      new Response(OFFLINE_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    )
  );
});
