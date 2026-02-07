const state = {
  airports: [],
  airportMap: new Map(),
  routes: [],
  activeField: 'from',
  selection: { from: null, to: null },
  best: [],
  kernel: null
};

// WASM Module Loader
async function initWasm() {
  try {
    const { default: createNukeKernel } = await import('./wasm/nuke_kernel.js');
    console.log('Creating WASM Kernel...');
    state.kernel = await createNukeKernel({
      locateFile: (path) => `./wasm/${path}`
    });
    
    if (!state.kernel.cwrap) {
      console.error('WASM Kernel loaded but cwrap is missing. Check EXPORTED_RUNTIME_METHODS.');
      throw new Error('cwrap missing');
    }

    // Bind WASM functions via cwrap (wraps C-exported symbols)
    state.kernel.initStore = state.kernel.cwrap('nuke_wasm_init', 'number', []);
    state.kernel.loadData = state.kernel.cwrap('nuke_wasm_load_data', 'number', ['number', 'number']);
    state.kernel.getAirports = state.kernel.cwrap('nuke_wasm_get_airports_json', 'string', []);
    state.kernel.getBest = state.kernel.cwrap('nuke_wasm_get_best_nodes_json', 'string', []);
    state.kernel.getHealth = state.kernel.cwrap('nuke_wasm_get_health_json', 'string', []);
    state.kernel.searchRoutes = state.kernel.cwrap('nuke_wasm_search_routes_json', 'string', ['string', 'string', 'number']);
    state.kernel.calcScore = state.kernel.cwrap('nuke_wasm_calc_score', 'number', ['number', 'number', 'number', 'number', 'number']);

    // cwrap returns the raw function for numeric-only signatures; fall back to
    // the underscore-prefixed direct export when the symbol is present but
    // cwrap could not resolve it (e.g. after streaming-compile race).
    if (typeof state.kernel.initStore !== 'function') {
      if (typeof state.kernel._nuke_wasm_init === 'function') {
        state.kernel.initStore = state.kernel._nuke_wasm_init;
      } else {
        throw new Error('initStore is not a function - symbol might be missing in WASM exports');
      }
    }

    state.kernel.initStore();

    // Load main routes/graph blob
    const response = await fetch('./wasm/nuke_blob.bin');
    if (!response.ok) throw new Error('Failed to fetch data blob');
    const blobArrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(blobArrayBuffer);
    
    if (state.kernel._malloc) {
      const ptr = state.kernel._malloc(uint8Array.length);
      if (!state.kernel.HEAPU8) {
        throw new Error('HEAPU8 is not available on WASM module');
      }
      state.kernel.HEAPU8.set(uint8Array, ptr);
      state.kernel.loadData(ptr, uint8Array.length);
      state.kernel._free(ptr);
    } else {
      console.warn('WASM _malloc not found, using alternative or data might not be loaded');
    }
    
    console.log('WASM Kernel initialized successfully');
  } catch (err) {
    console.error('WASM Kernel failed to load:', err);
    state.kernel = null;
  }
}

async function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js', {
        scope: './',
        type: 'module'
      });
      // Wait for SW to be active and controlling this page
      await navigator.serviceWorker.ready;
      console.log('Service Worker ready at scope:', navigator.serviceWorker.controller?.scriptURL);
    } catch (err) {
      console.warn('Service Worker failed:', err);
    }
  }
}

const continentShapes = [
  [[-168,72],[-140,60],[-120,50],[-110,45],[-95,50],[-80,45],[-60,45],[-55,25],[-75,8],[-95,10],[-120,25],[-135,40],[-150,60]],
  [[-82,12],[-75,-2],[-70,-15],[-65,-30],[-60,-50],[-45,-55],[-40,-30],[-50,0]],
  [[-10,70],[40,70],[90,60],[120,60],[140,50],[160,45],[170,60],[180,75],[180,25],[150,20],[120,20],[90,10],[60,5],[40,-10],[20,-20],[0,-25],[-10,0],[-5,20]],
  [[-20,35],[10,35],[25,32],[35,20],[30,5],[25,-10],[20,-25],[15,-35],[0,-30],[-10,-5]],
  [[110,-10],[125,-25],[140,-35],[150,-35],[155,-25],[150,-15],[135,-10],[120,-15]]
];

document.addEventListener('DOMContentLoaded', () => {
  const mainCanvas = document.getElementById('route-map');
  const loader = document.getElementById('map-loader');
  const statusEl = document.getElementById('map-status');
  const resultsEl = document.getElementById('route-results');
  const fromInput = document.getElementById('from-code');
  const toInput = document.getElementById('to-code');
  const transfersInput = document.getElementById('max-transfers');
  const resultsInput = document.getElementById('max-results');
  const statAirports = document.getElementById('stat-airports');
  const statRoutes = document.getElementById('stat-routes');
  const statWorkers = document.getElementById('stat-workers');
  const selectionFrom = document.getElementById('selection-from');
  const selectionTo = document.getElementById('selection-to');
  const swapBtn = document.getElementById('swap-btn');
  const searchBtn = document.getElementById('search-btn');
  const modeButtons = document.querySelectorAll('.map-mode button');
  const bestContainer = document.getElementById('best-results');
  const bestRefreshBtn = document.getElementById('best-refresh-btn');
  const mapModal = document.getElementById('map-modal');
  const modalCanvas = document.getElementById('route-map-large');
  const modalCloseBtn = document.getElementById('map-modal-close');

  const projectPoint = (lon, lat) => ({ u: (lon + 180) / 360, v: (90 - lat) / 180 });
  const view = { zoom: 1, minZoom: 1, maxZoom: 5, centerX: 0.5, centerY: 0.5 };
  let statusBeforeModal = '';
  const dragState = { active: false, pointerId: null, lastX: 0, lastY: 0, moved: false, blockClick: false };
  const mapCanvases = new Map();

  function registerCanvas(key, element) { if (!element) return; mapCanvases.set(key, { canvas: element, ctx: element.getContext('2d') }); }
  registerCanvas('main', mainCanvas);
  registerCanvas('modal', modalCanvas);

  function getViewWindow() {
    const width = 1 / view.zoom, height = 1 / view.zoom;
    return { left: view.centerX - width/2, top: view.centerY - height/2, width, height };
  }

  function clampViewCenter() {
    const halfW = 0.5 / view.zoom, halfH = 0.5 / view.zoom;
    if (1/view.zoom >= 1) { view.centerX = 0.5; view.centerY = 0.5; }
    else {
      view.centerX = Math.min(Math.max(view.centerX, halfW), 1 - halfW);
      view.centerY = Math.min(Math.max(view.centerY, halfH), 1 - halfH);
    }
  }

  function worldToCanvas(u, v, viewport, targetCanvas) {
    return { x: ((u - viewport.left) / viewport.width) * targetCanvas.width, y: ((v - viewport.top) / viewport.height) * targetCanvas.height };
  }

  function canvasToWorld(normX, normY, viewport) {
    return { u: viewport.left + normX * viewport.width, v: viewport.top + normY * viewport.height };
  }

  function resizeAllCanvases() {
    mapCanvases.forEach(target => {
      const rect = target.canvas.getBoundingClientRect();
      target.canvas.width = rect.width; target.canvas.height = rect.height;
    });
    drawAllScenes();
  }

  function drawSceneOnTarget(target) {
    const { ctx, canvas } = target; if (!canvas.width) return;
    const viewport = getViewWindow();
    ctx.fillStyle = '#02142f'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(110,231,255,0.2)'; ctx.lineWidth = 1.2;
    continentShapes.forEach(shape => {
      ctx.beginPath();
      shape.forEach(([lon, lat], i) => {
        const p = projectPoint(lon, lat); const c = worldToCanvas(p.u, p.v, viewport, canvas);
        if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y);
      });
      ctx.closePath(); ctx.stroke();
    });
    state.airports.forEach(a => {
      const c = worldToCanvas(a.u, a.v, viewport, canvas);
      const sel = (state.selection.from?.code === a.code || state.selection.to?.code === a.code);
      ctx.fillStyle = sel ? '#fbbf24' : 'rgba(148,163,184,0.55)';
      ctx.beginPath(); ctx.arc(c.x, c.y, sel ? 4 : 2, 0, Math.PI*2); ctx.fill();
    });
    state.routes.forEach((route, idx) => {
      ctx.strokeStyle = idx === 0 ? '#22d3ee' : '#5eead4'; ctx.lineWidth = 2; ctx.beginPath();
      route.airports.map(a => state.airportMap.get(a.code)).filter(Boolean).forEach((a, i) => {
        const c = worldToCanvas(a.u, a.v, viewport, canvas);
        if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y);
      });
      ctx.stroke();
    });
  }

  function drawAllScenes() { mapCanvases.forEach(drawSceneOnTarget); }

  function setInputField(field, value) {
    const val = (value || '').trim().toUpperCase();
    if (field === 'from') fromInput.value = val; else toInput.value = val;
    state.selection[field] = state.airportMap.get(val) || null;
    selectionFrom.textContent = state.selection.from?.code || '--';
    selectionTo.textContent = state.selection.to?.code || '--';
    drawAllScenes();
  }

  async function fetchAirports() {
    loader.textContent = '공항 데이터를 불러오는 중...';
    try {
      let data;
      // Try SW-intercepted endpoint first; fall back to direct JSON file
      // when the service worker is not yet controlling this page (first visit).
      const swControlling = !!navigator.serviceWorker?.controller;
      if (swControlling) {
        const response = await fetch('./airports?limit=1024');
        if (response.ok) {
          const ct = response.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            data = await response.json();
          }
        }
      }
      if (!data) {
        const response = await fetch('./airports.json');
        if (!response.ok) throw new Error('공항 데이터를 불러오지 못했습니다.');
        const allAirports = await response.json();
        data = { airports: allAirports.slice(0, 1024) };
      }
      const airports = Array.isArray(data.airports) ? data.airports : [];
      state.airports = airports.map(a => ({ ...a, ...projectPoint(a.lon, a.lat) }));
      state.airportMap = new Map(state.airports.map(a => [a.code, a]));
      statAirports.textContent = state.airports.length.toLocaleString();
      loader.style.display = 'none';
      drawAllScenes();
    } catch (err) {
      loader.textContent = '데이터 로드 실패: ' + err.message;
    }
  }

  function searchRoutes() {
    const from = fromInput.value.trim().toUpperCase(), to = toInput.value.trim().toUpperCase();
    const maxT = parseInt(transfersInput.value) || 0;
    if (from.length !== 3 || to.length !== 3) return;
    if (!state.kernel) { statusEl.textContent = 'WASM 커널이 로드되지 않았습니다.'; return; }
    statusEl.textContent = 'WASM 분석 중...';
    try {
      const data = JSON.parse(state.kernel.searchRoutes(from, to, maxT));
      state.routes = data.paths || [];
      resultsEl.innerHTML = state.routes.map((p, i) => `
        <div class="result-card">
          <h3>경로 ${i+1}: ${p.airports.map(a => a.code).join(' → ')}</h3>
          <p>${p.legs}구간 · ${p.totalDistanceKm.toFixed(1)}km · 효율 ${p.efficiency.toFixed(3)}</p>
        </div>
      `).join('') || '<div class="empty-state">경로 없음</div>';
      statusEl.textContent = `분석 완료: ${state.routes.length}개 발견`;
      drawAllScenes();
      refreshBestHubs();
    } catch (err) { statusEl.textContent = '오류: ' + err.message; }
  }

  mainCanvas.addEventListener('click', (e) => {
    const rect = mainCanvas.getBoundingClientRect();
    const world = canvasToWorld((e.clientX - rect.left)/rect.width, (e.clientY - rect.top)/rect.height, getViewWindow());
    const lon = world.u * 360 - 180, lat = 90 - world.v * 180;
    let best = null, minDist = Infinity;
    state.airports.forEach(a => {
      const d = Math.pow(a.lat-lat, 2) + Math.pow(a.lon-lon, 2);
      if (d < minDist) { minDist = d; best = a; }
    });
    if (best) setInputField(state.activeField, best.code);
  });

  swapBtn.addEventListener('click', () => { const f = fromInput.value, t = toInput.value; setInputField('from', t); setInputField('to', f); });
  modeButtons.forEach(b => b.addEventListener('click', () => { modeButtons.forEach(x => x.classList.remove('active')); b.classList.add('active'); state.activeField = b.dataset.field; }));
  searchBtn.addEventListener('click', searchRoutes);
  window.addEventListener('resize', resizeAllCanvases);

  // Haversine distance in km between two lat/lon points
  function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = v => v * Math.PI / 180;
    const dlat = toRad(lat2 - lat1), dlon = toRad(lon2 - lon1);
    const a = Math.sin(dlat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dlon/2)**2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Dynamically compute top-5 hub airports from actual route search data.
  // When origin/destination are set, ranks hubs by best route efficiency
  // through each candidate airport. Otherwise ranks by geographic
  // connectivity (average reachability to a diverse set of world airports).
  function computeBestHubs() {
    if (!state.kernel || state.airports.length === 0) return [];

    const from = fromInput.value.trim().toUpperCase();
    const to = toInput.value.trim().toUpperCase();
    const hasContext = from.length === 3 && to.length === 3 && from !== to;

    if (hasContext) {
      // Contextual mode: find best intermediate hubs for this specific route.
      // For each loaded airport (that is not src/dst), search actual routes
      // src→hub and hub→dst, combine total distance vs great-circle.
      const srcAirport = state.airportMap.get(from);
      const dstAirport = state.airportMap.get(to);
      if (!srcAirport || !dstAirport) return [];

      const gcDirect = haversineKm(srcAirport.lat, srcAirport.lon, dstAirport.lat, dstAirport.lon);
      const candidates = [];

      // Sample a manageable subset — pick airports spread across the globe
      const sample = state.airports.filter(a => a.code !== from && a.code !== to);
      // Limit to ~100 candidates for performance: pick evenly from sorted list
      const step = Math.max(1, Math.floor(sample.length / 100));
      const subset = sample.filter((_, i) => i % step === 0);

      for (const hub of subset) {
        try {
          const leg1 = JSON.parse(state.kernel.searchRoutes(from, hub.code, 0));
          const leg2 = JSON.parse(state.kernel.searchRoutes(hub.code, to, 0));
          if (!leg1.paths?.length || !leg2.paths?.length) continue;
          const totalDist = leg1.paths[0].totalDistanceKm + leg2.paths[0].totalDistanceKm;
          const efficiency = gcDirect / totalDist;
          candidates.push({
            code: hub.code, lat: hub.lat, lon: hub.lon,
            totalDistanceKm: totalDist, efficiency,
            leg1Km: leg1.paths[0].totalDistanceKm,
            leg2Km: leg2.paths[0].totalDistanceKm
          });
        } catch { /* skip unreachable airports */ }
      }

      candidates.sort((a, b) => b.efficiency - a.efficiency);
      return candidates.slice(0, 5).map(c => ({
        anchorAirport: c.code, lat: c.lat, lon: c.lon,
        detail: `${from}→${c.code} ${c.leg1Km.toFixed(0)}km + ${c.code}→${to} ${c.leg2Km.toFixed(0)}km`,
        metric: `총 ${c.totalDistanceKm.toFixed(0)}km · 효율 ${(c.efficiency * 100).toFixed(1)}%`
      }));
    }

    // Global mode: rank airports by outbound connectivity using real route searches.
    // Pick geographically diverse probe destinations and measure how many each
    // airport can reach with actual paths (max 1 transfer).
    const probes = pickProbeAirports(6);

    // Sample ~100 candidate airports spread across the globe for performance
    const sampleStep = Math.max(1, Math.floor(state.airports.length / 100));
    const sampleAirports = state.airports.filter((_, i) => i % sampleStep === 0);
    const scores = new Map();

    for (const airport of sampleAirports) {
      let reachable = 0, totalEfficiency = 0;
      for (const probe of probes) {
        if (probe.code === airport.code) continue;
        try {
          const result = JSON.parse(state.kernel.searchRoutes(airport.code, probe.code, 2));
          if (result.paths?.length) {
            reachable++;
            totalEfficiency += result.paths[0].efficiency;
          }
        } catch { /* skip */ }
      }
      if (reachable > 0) {
        scores.set(airport.code, {
          code: airport.code, lat: airport.lat, lon: airport.lon,
          reachable, avgEfficiency: totalEfficiency / reachable
        });
      }
    }

    const ranked = [...scores.values()]
      .sort((a, b) => b.reachable - a.reachable || b.avgEfficiency - a.avgEfficiency)
      .slice(0, 5);

    return ranked.map(r => ({
      anchorAirport: r.code, lat: r.lat, lon: r.lon,
      detail: `${r.reachable}/${probes.length} 프로브 도달`,
      metric: `평균 효율 ${(r.avgEfficiency * 100).toFixed(1)}%`
    }));
  }

  // Pick geographically spread probe airports from loaded data
  function pickProbeAirports(count) {
    if (state.airports.length <= count) return [...state.airports];
    // Divide world longitude into equal buckets and pick one from each
    const buckets = Array.from({ length: count }, () => []);
    const bucketWidth = 360 / count;
    for (const a of state.airports) {
      const idx = Math.min(count - 1, Math.floor((a.lon + 180) / bucketWidth));
      buckets[idx].push(a);
    }
    return buckets
      .filter(b => b.length > 0)
      .map(b => b[Math.floor(b.length / 2)]);
  }

  function renderBestNodes(items) {
    if (!items.length) {
      bestContainer.innerHTML = '<div class="empty-state">경로 데이터 분석 중 허브를 찾지 못했습니다.</div>';
      return;
    }
    bestContainer.innerHTML = items.map((n, i) =>
      `<div class="best-card-item">` +
        `<div class="best-card-header"><strong>#${i+1} ${n.anchorAirport}</strong></div>` +
        `<p>${n.detail}</p>` +
        `<p class="best-meta">${n.metric}</p>` +
      `</div>`
    ).join('');
  }

  async function refreshBestHubs() {
    bestContainer.classList.add('loading');
    // Use setTimeout to allow the UI to update before blocking computation
    await new Promise(r => setTimeout(r, 50));
    const hubs = computeBestHubs();
    renderBestNodes(hubs);
    bestContainer.classList.remove('loading');
  }

  async function init() {
    await initServiceWorker();
    await initWasm();
    await fetchAirports();
    if (state.kernel) {
      const h = JSON.parse(state.kernel.getHealth());
      statRoutes.textContent = h.routes_loaded.toLocaleString();
      statWorkers.textContent = 'WASM-Serverless';
      await refreshBestHubs();
    }
  }

  bestRefreshBtn.addEventListener('click', refreshBestHubs);

  resizeAllCanvases();
  init();
});
