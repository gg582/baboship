/* WASM Server Service Worker */
import createNukeKernel from './wasm/nuke_kernel.js';

let kernel = null;
let kernelPromise = null;

async function getKernel() {
  if (kernel) return kernel;
  if (!kernelPromise) {
    kernelPromise = createNukeKernel({
      locateFile: (path) => `wasm/${path}`
    });
  }
  kernel = await kernelPromise;
  return kernel;
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Only intercept requests to our mock endpoints
  const endpoints = ['/best', '/health', '/airports', '/routes'];
  const endpoint = endpoints.find(e => url.pathname.endsWith(endpointFix(e)));
  
  if (endpoint) {
    event.respondWith(handleRequest(endpoint, url));
  }
});

// Helper to handle base path in GitHub Pages
function endpointFix(e) {
  // If the pathname is /baboship/best, we want to match /best
  return e;
}

async function handleRequest(endpoint, url) {
  try {
    if (endpoint.endsWith('/best')) {
      const k = await getKernel();
      const jsonPtr = k._nuke_wasm_get_best_nodes_json();
      const jsonStr = k.UTF8ToString(jsonPtr);
      return new Response(jsonStr, {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (endpoint.endsWith('/health')) {
      return new Response(JSON.stringify({
        status: 'online',
        wasm: true,
        worker: 'ServiceWorker'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (endpoint.endsWith('/airports')) {
      // Mock empty list for now, as DB is not loaded in browser yet
      return new Response(JSON.stringify({
        total: 0,
        offset: 0,
        airports: [],
        returned: 0,
        note: 'Full airport data requires NukeDB server. Static version coming soon.'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (endpoint.endsWith('/routes')) {
      return new Response(JSON.stringify({
        error: 'Route calculation requires NukeDB server.',
        paths: []
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return fetch(event.request);
}
