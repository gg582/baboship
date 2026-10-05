/* WASM Server Service Worker - Witty Interception */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function handleAirports(url) {
  const limit = parseInt(url.searchParams.get('limit')) || 8192;
  const offset = parseInt(url.searchParams.get('offset')) || 0;
  
  try {
    const response = await fetch('./airports.json');
    const allAirports = await response.json();
    const sliced = allAirports.slice(offset, offset + limit);
    
    return new Response(JSON.stringify({
      total: allAirports.length,
      offset: offset,
      returned: sliced.length,
      airports: sliced
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to load airports.json' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = self.registration.scope;
  
  // Normalize path relative to scope
  let path = url.pathname;
  if (path.startsWith(new URL(scope).pathname)) {
    path = '/' + path.slice(new URL(scope).pathname.length);
  }
  path = path.replace(/\/+$/, ''); // remove trailing slash

  if (path === '/airports') {
    event.respondWith(handleAirports(url));
  }
  // All other requests (wasm files, static assets, etc.) are handled by the
  // browser's default fetch – no event.respondWith() call needed.
});
