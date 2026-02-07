const state = {
  airports: [],
  airportMap: new Map(),
  routes: [],
  activeField: 'from',
  selection: { from: null, to: null },
  best: [],
  kernel: null,
  bestWorker: null,
  bestRequestId: 0
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
  const bestFromTitle = document.getElementById('best-from-title');
  const bestToTitle = document.getElementById('best-to-title');
  const bestFromResults = document.getElementById('best-from-results');
  const bestToResults = document.getElementById('best-to-results');
  const bestFromRefreshBtn = document.getElementById('best-from-refresh-btn');
  const bestToRefreshBtn = document.getElementById('best-to-refresh-btn');
  const mapModal = document.getElementById('map-modal');
  const modalCanvas = document.getElementById('route-map-large');
  const modalCloseBtn = document.getElementById('map-modal-close');

  const projectPoint = (lon, lat) => {
    const u = (lon + 180) / 360;
    // Clamp latitude to Web Mercator bounds (±85.051129°) to avoid singularity at poles
    const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat));
    const latRad = clampedLat * Math.PI / 180;
    const v = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
    return { u, v };
  };
  const view = { zoom: 1, minZoom: 1, maxZoom: 18, centerX: 0.5, centerY: 0.5 };

  // --- OpenStreetMap tile layer ---
  const tileCache = new Map();

  function getTileImage(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const entry = { img, loaded: false };
    img.onload = () => { entry.loaded = true; drawAllScenes(); };
    img.onerror = () => { entry.loaded = false; };
    img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    tileCache.set(key, entry);
    // Cap cache at ~600 tiles (~150 MB) to limit memory usage
    if (tileCache.size > 600) {
      const iter = tileCache.keys();
      for (let i = 0; i < 60; i++) {
        const k = iter.next().value;
        if (k) tileCache.delete(k);
      }
    }
    return entry;
  }

  function drawTiles(ctx, canvas, viewport) {
    // Determine OSM zoom level from our continuous zoom
    const osmZoom = Math.max(0, Math.min(18, Math.round(Math.log2(view.zoom) + 1)));
    const numTiles = Math.pow(2, osmZoom);

    // Visible range in tile coords
    const tileLeft = Math.floor(viewport.left * numTiles);
    const tileRight = Math.ceil((viewport.left + viewport.width) * numTiles);
    const tileTop = Math.floor(viewport.top * numTiles);
    const tileBottom = Math.ceil((viewport.top + viewport.height) * numTiles);

    for (let tx = tileLeft; tx < tileRight; tx++) {
      for (let ty = tileTop; ty < tileBottom; ty++) {
        // Wrap horizontally, skip out-of-range vertically
        const wrappedX = ((tx % numTiles) + numTiles) % numTiles;
        if (ty < 0 || ty >= numTiles) continue;

        const entry = getTileImage(osmZoom, wrappedX, ty);
        // Tile bounds in [0,1] world space
        const tileU = tx / numTiles;
        const tileV = ty / numTiles;
        const tileSizeU = 1 / numTiles;
        const tileSizeV = 1 / numTiles;

        const sx = ((tileU - viewport.left) / viewport.width) * canvas.width;
        const sy = ((tileV - viewport.top) / viewport.height) * canvas.height;
        const sw = (tileSizeU / viewport.width) * canvas.width;
        const sh = (tileSizeV / viewport.height) * canvas.height;

        if (entry.loaded) {
          ctx.drawImage(entry.img, sx, sy, sw, sh);
        } else {
          ctx.fillStyle = '#1a1a2e';
          ctx.fillRect(sx, sy, sw, sh);
        }
      }
    }
  }
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
    // Draw OSM tile layer
    drawTiles(ctx, canvas, viewport);
    // Scale airport dot radius with zoom so dots remain visible at high zoom levels.
    // Beyond a baseline zoom the radius grows logarithmically to stay perceptible
    // against the increasingly detailed tile layer.
    const baseZoom = 4;
    const dotScale = view.zoom > baseZoom ? Math.max(1, 1 + Math.log2(view.zoom / baseZoom)) : 1;
    state.airports.forEach(a => {
      const c = worldToCanvas(a.u, a.v, viewport, canvas);
      const sel = (state.selection.from?.code === a.code || state.selection.to?.code === a.code);
      ctx.fillStyle = sel ? '#fbbf24' : 'rgba(148,163,184,0.55)';
      const r = (sel ? 4 : 2) * dotScale;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI*2); ctx.fill();
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
        const response = await fetch('./airports?limit=8192');
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
        data = { airports: allAirports.slice(0, 8192) };
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
    } catch (err) { statusEl.textContent = '오류: ' + err.message; }
  }

  function handleCanvasClick(canvas, e) {
    if (dragState.blockClick) return;
    const rect = canvas.getBoundingClientRect();
    const world = canvasToWorld((e.clientX - rect.left)/rect.width, (e.clientY - rect.top)/rect.height, getViewWindow());
    const lon = world.u * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * world.v)));
    const lat = latRad * 180 / Math.PI;
    let best = null, minDist = Infinity;
    state.airports.forEach(a => {
      const d = Math.pow(a.lat-lat, 2) + Math.pow(a.lon-lon, 2);
      if (d < minDist) { minDist = d; best = a; }
    });
    if (best) setInputField(state.activeField, best.code);
  }

  function handlePointerDown(canvas, e) {
    if (e.button !== 0) return;
    dragState.active = true; dragState.pointerId = e.pointerId;
    dragState.lastX = e.clientX; dragState.lastY = e.clientY;
    dragState.moved = false; dragState.blockClick = false;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  }

  function handlePointerMove(canvas, e) {
    if (!dragState.active || e.pointerId !== dragState.pointerId) return;
    const dx = e.clientX - dragState.lastX, dy = e.clientY - dragState.lastY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragState.moved = true;
    const rect = canvas.getBoundingClientRect();
    view.centerX -= dx / rect.width / view.zoom;
    view.centerY -= dy / rect.height / view.zoom;
    clampViewCenter();
    dragState.lastX = e.clientX; dragState.lastY = e.clientY;
    drawAllScenes();
  }

  function handlePointerUp(canvas, e) {
    if (e.pointerId !== dragState.pointerId) return;
    canvas.classList.remove('dragging');
    dragState.blockClick = dragState.moved;
    dragState.active = false; dragState.pointerId = null;
  }

  function handleWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    view.zoom = Math.min(view.maxZoom, Math.max(view.minZoom, view.zoom * factor));
    clampViewCenter();
    drawAllScenes();
  }

  function openMapModal() {
    statusBeforeModal = statusEl.textContent;
    mapModal.classList.add('open'); mapModal.setAttribute('aria-hidden', 'false');
    resizeAllCanvases();
  }

  function closeMapModal() {
    mapModal.classList.remove('open'); mapModal.setAttribute('aria-hidden', 'true');
    statusEl.textContent = statusBeforeModal;
  }

  [mainCanvas, modalCanvas].forEach(canvas => {
    canvas.addEventListener('click', (e) => handleCanvasClick(canvas, e));
    canvas.addEventListener('pointerdown', (e) => handlePointerDown(canvas, e));
    canvas.addEventListener('pointermove', (e) => handlePointerMove(canvas, e));
    canvas.addEventListener('pointerup', (e) => handlePointerUp(canvas, e));
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); openMapModal(); });
  });

  modalCloseBtn.addEventListener('click', closeMapModal);
  mapModal.addEventListener('click', (e) => { if (e.target === mapModal) closeMapModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mapModal.classList.contains('open')) closeMapModal(); });

  swapBtn.addEventListener('click', () => { const f = fromInput.value, t = toInput.value; setInputField('from', t); setInputField('to', f); });
  modeButtons.forEach(b => b.addEventListener('click', () => { modeButtons.forEach(x => x.classList.remove('active')); b.classList.add('active'); state.activeField = b.dataset.field; }));
  searchBtn.addEventListener('click', searchRoutes);
  window.addEventListener('resize', resizeAllCanvases);

  function renderBestDestinations(container, data) {
    container.innerHTML = '';
    container.className = 'best-continent-container';
    const continents = Object.keys(data);
    if (!continents.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '목적지를 찾을 수 없습니다.';
      container.appendChild(empty);
      return;
    }
    continents.forEach(continent => {
      const group = document.createElement('div');
      group.className = 'best-continent-group';
      const header = document.createElement('h3');
      header.className = 'best-continent-header';
      header.textContent = continent;
      group.appendChild(header);
      const grid = document.createElement('div');
      grid.className = 'best-grid';
      data[continent].forEach((dest, i) => {
        const card = document.createElement('article');
        card.className = 'best-card-item';
        const cardHeader = document.createElement('div');
        cardHeader.className = 'best-card-header';
        const strong = document.createElement('strong');
        strong.textContent = '#' + (i + 1) + ' ' + dest.code;
        cardHeader.appendChild(strong);
        card.appendChild(cardHeader);
        const body = document.createElement('p');
        body.textContent = dest.route;
        card.appendChild(body);
        const meta = document.createElement('div');
        meta.className = 'best-meta';
        const dist = document.createElement('span');
        dist.textContent = dest.distanceKm.toFixed(0) + ' km';
        const eff = document.createElement('span');
        eff.textContent = '효율 ' + (dest.efficiency * 100).toFixed(1) + '%';
        meta.appendChild(dist);
        meta.appendChild(eff);
        card.appendChild(meta);
        grid.appendChild(card);
      });
      group.appendChild(grid);
      container.appendChild(group);
    });
  }

  function requestBestFrom() {
    if (!state.bestWorker) return;
    const fromCode = fromInput.value.trim().toUpperCase();
    const airports = state.airports.map(a => ({ code: a.code, lat: a.lat, lon: a.lon }));
    if (fromCode.length !== 3 || !state.airportMap.has(fromCode)) {
      bestFromResults.innerHTML = '<div class="empty-state">유효한 3자리 IATA 코드를 입력하세요.</div>';
      return;
    }
    bestFromTitle.textContent = fromCode + '에서 최적 목적지';
    bestFromResults.classList.add('loading');
    bestFromResults.innerHTML = '<div class="empty-state">계산 중...</div>';
    state.bestRequestId++;
    state.bestWorker.postMessage({ type: 'compute', id: state.bestRequestId, originCode: fromCode, airports });
  }

  function requestBestTo() {
    if (!state.bestWorker) return;
    const toCode = toInput.value.trim().toUpperCase();
    const airports = state.airports.map(a => ({ code: a.code, lat: a.lat, lon: a.lon }));
    if (toCode.length !== 3 || !state.airportMap.has(toCode)) {
      bestToResults.innerHTML = '<div class="empty-state">유효한 3자리 IATA 코드를 입력하세요.</div>';
      return;
    }
    bestToTitle.textContent = toCode + '에서 최적 목적지';
    bestToResults.classList.add('loading');
    bestToResults.innerHTML = '<div class="empty-state">계산 중...</div>';
    state.bestRequestId++;
    state.bestWorker.postMessage({ type: 'compute', id: state.bestRequestId, originCode: toCode, airports });
  }

  async function init() {
    await initServiceWorker();
    await initWasm();
    await fetchAirports();

    // Start the best-destinations Web Worker (separate WASM instance)
    try {
      state.bestWorker = new Worker('./best-worker.js', { type: 'module' });
      state.bestWorker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'init') {
          if (msg.ok) console.log('Best-destinations worker ready');
          else console.warn('Best-destinations worker init failed:', msg.error);
          return;
        }
        if (msg.type === 'result') {
          const fromCode = fromInput.value.trim().toUpperCase();
          const toCode = toInput.value.trim().toUpperCase();
          if (msg.originCode === fromCode) {
            renderBestDestinations(bestFromResults, msg.data);
            bestFromResults.classList.remove('loading');
          }
          if (msg.originCode === toCode) {
            renderBestDestinations(bestToResults, msg.data);
            bestToResults.classList.remove('loading');
          }
          return;
        }
        if (msg.type === 'error') {
          console.warn('Best-destinations worker error:', msg.error);
        }
      };
      state.bestWorker.postMessage({ type: 'init' });
    } catch (err) {
      console.warn('Web Worker not available:', err);
    }

    if (state.kernel) {
      const h = JSON.parse(state.kernel.getHealth());
      statRoutes.textContent = h.routes_loaded.toLocaleString();
      statWorkers.textContent = 'WASM-Serverless';
    }
  }

  bestFromRefreshBtn.addEventListener('click', requestBestFrom);
  bestToRefreshBtn.addEventListener('click', requestBestTo);

  resizeAllCanvases();
  init();
});
