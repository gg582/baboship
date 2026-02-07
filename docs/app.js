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
      const heapu8 = state.kernel.HEAPU8 || new Uint8Array(state.kernel.wasmMemory?.buffer || state.kernel.buffer);
      heapu8.set(uint8Array, ptr);
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
      const reg = await navigator.serviceWorker.register('./sw.js', {
        scope: './',
        type: 'module'
      });
      // Wait for SW to be active
      if (reg.installing) await new Promise(r => reg.installing.addEventListener('statechange', (e) => { if (e.target.state === 'activated') r(); }));
      console.log('Service Worker ready at scope:', reg.scope);
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
    loader.textContent = '가짜 서버(/airports)에서 데이터 가로채는 중...';
    try {
      // Witty Interception: This fetch is intercepted by sw.js
      const response = await fetch('./airports?limit=1024');
      const data = await response.json();
      state.airports = data.airports.map(a => ({ ...a, ...projectPoint(a.lon, a.lat) }));
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

  async function init() {
    await initServiceWorker();
    await initWasm();
    await fetchAirports();
    if (state.kernel) {
      const h = JSON.parse(state.kernel.getHealth());
      statRoutes.textContent = h.routes_loaded.toLocaleString();
      statWorkers.textContent = 'WASM-Serverless';
      bestContainer.innerHTML = JSON.parse(state.kernel.getBest()).items.map(n => `<div class="best-card-item"><strong>${n.anchorAirport}</strong><p>${n.notes}</p></div>`).join('');
    }
  }

  resizeAllCanvases();
  init();
});
