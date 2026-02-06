/* WASM Server Service Worker */
import createNukeKernel from './wasm/nuke_kernel.js';

let kernel = null;
let kernelPromise = null;

async function getKernel() {
  if (kernel) return kernel;
  if (!kernelPromise) {
    kernelPromise = createNukeKernel({
      locateFile: (path) => `./wasm/${path}`
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

async function handleRequest(endpoint, url, request) {
  try {
    const k = await getKernel();
    
    if (endpoint.endsWith('/best')) {
      const jsonPtr = k._nuke_wasm_get_best_nodes_json();
      const jsonStr = k.UTF8ToString(jsonPtr);
      return new Response(jsonStr, {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (endpoint.endsWith('/health')) {
      const jsonPtr = k._nuke_wasm_get_health_json();
      const jsonStr = k.UTF8ToString(jsonPtr);
      return new Response(jsonStr, {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (endpoint.endsWith('/airports')) {
      const jsonPtr = k._nuke_wasm_get_airports_json();
      const jsonStr = k.UTF8ToString(jsonPtr);
      return new Response(jsonStr, {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (endpoint.endsWith('/routes')) {
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';
      const jsonPtr = k._nuke_wasm_search_routes_json(
        k.allocate(k.intArrayFromString(from), k.ALLOC_NORMAL),
        k.allocate(k.intArrayFromString(to), k.ALLOC_NORMAL)
      );
      const jsonStr = k.UTF8ToString(jsonPtr);
      return new Response(jsonStr, {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return fetch(request);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = self.registration.scope;
  const relativePath = url.pathname.startsWith(scope) 
    ? '/' + url.pathname.slice(scope.length)
    : url.pathname;
  
  // Only intercept requests to our mock endpoints
  const endpoints = ['/best', '/health', '/airports', '/routes'];
  const endpoint = endpoints.find(e => relativePath === e || relativePath === e + '/');
  
  if (endpoint) {
    event.respondWith(handleRequest(endpoint, url, event.request));
  }
});
