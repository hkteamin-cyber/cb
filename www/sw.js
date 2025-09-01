self.addEventListener('install', (e)=>{
  self.skipWaiting();
});
self.addEventListener('activate', (e)=>{
  clients.claim();
});

const CACHE_NAME = 'hksim-speedtest-v1';
const ASSETS = [
  '/',
  '/speedtest.html',
  '/css/style.css',
  '/manifest.webmanifest'
];

self.addEventListener('fetch', (event)=>{
  const { request } = event;
  if(request.method !== 'GET') return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      try {
        const network = await fetch(request);
        if(request.url.startsWith(self.location.origin)){
          cache.put(request, network.clone());
        }
        return network;
      } catch (err) {
        const cached = await cache.match(request);
        if(cached) return cached;
        return caches.match('/speedtest.html');
      }
    })
  );
});