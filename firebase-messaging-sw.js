// Receives push notifications for the grades dashboard while the page is closed.
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const config = JSON.parse(new URL(self.location.href).searchParams.get('config') || '{}');
if (config.apiKey) {
  firebase.initializeApp(config);
  firebase.messaging(); // displays incoming notifications and opens the dashboard on tap
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
