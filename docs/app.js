const state = {
  airports: [],
  airportMap: new Map(),
  routes: [],
  activeField: 'from',
  selection: { from: null, to: null },
  best: [],
  kernel: null,
  bestWorker: null,
  bestRequestId: 0,
  isMobile: false,
  uiMode: 'manual',
  trackingEvents: [],
  wasmUnavailableReason: '',
  nativeMode: false,
  nativeHealth: null,
  nativeDirectCache: new Map()
};

function getWasmUnavailableMessage(fallback = 'WASM 커널이 아직 초기화되지 않았습니다.') {
  return state.wasmUnavailableReason || fallback;
}

function resolveAssetBase() {
  const current = document.currentScript || (() => {
    const scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();
  if (current && current.src) {
    return new URL('.', current.src);
  }
  return new URL('./', window.location.href);
}

const ASSET_BASE = resolveAssetBase();
const resolveAsset = (path) => new URL(path, ASSET_BASE).href;

const assetPaths = {
  wasmModule: resolveAsset('wasm/nuke_kernel.js'),
  wasmBlob: resolveAsset('wasm/nuke_blob.bin'),
  workerScript: resolveAsset('best-worker.js'),
  airportsJson: resolveAsset('airports.json'),
  serviceWorker: resolveAsset('sw.js')
};

const trackerConfig = (typeof window !== 'undefined' && window.__baboship_config) ? window.__baboship_config : {};
const TRACKER_DELIVERY_API = trackerConfig.trackerApiBase || 'https://apis.tracker.delivery';
const TRACKER_API_KEY = trackerConfig.trackerApiKey || '';

function clampNumber(value, min, max) {
  const num = Number(value);
  if (Number.isNaN(num)) return min;
  if (typeof min === 'number' && num < min) return min;
  if (typeof max === 'number' && num > max) return max;
  return num;
}

async function fetchJsonOrError(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      if (response.ok) {
        throw new Error('JSON 파싱 실패');
      }
    }
  }
  if (!response.ok) {
    const detail = (parsed && parsed.error) || (raw ? raw.trim() : '');
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return parsed ?? {};
}

async function fetchNativeRoutes(from, to, maxTransfers, maxResults) {
  const params = new URLSearchParams({
    from,
    to,
    maxTransfers: String(maxTransfers),
    maxResults: String(maxResults || 10)
  });
  return fetchJsonOrError(`./routes?${params.toString()}`);
}

async function fetchNativeDirectDestinations(code) {
  if (state.nativeDirectCache.has(code)) {
    return state.nativeDirectCache.get(code);
  }
  const params = new URLSearchParams({ code });
  const data = await fetchJsonOrError(`./direct?${params.toString()}`);
  state.nativeDirectCache.set(code, data);
  return data;
}

async function analyzeTrackingNative(payload) {
  return fetchJsonOrError('./tracking/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ log: payload })
  });
}

// Mobile device detection
function detectMobile() {
  // Primary check: user agent for common mobile/tablet devices
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;
  
  // Feature detection: touch support combined with screen size
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isMobileScreen = window.innerWidth <= 768;
  
  // Return true if user agent matches mobile patterns, or if device has touch and smaller screen
  // This allows iPads to be detected via user agent but excludes desktop touch screens
  return mobileRegex.test(userAgent.toLowerCase()) || (hasTouch && isMobileScreen);
}

// WASM Module Loader
async function initWasm() {
  if (typeof WebAssembly === 'undefined') {
    state.kernel = null;
    state.wasmUnavailableReason = '이 브라우저는 WebAssembly를 지원하지 않습니다.';
    return false;
  }
  if (window.location.protocol === 'file:') {
    state.kernel = null;
    state.wasmUnavailableReason = '파일 시스템에서 직접 열면 WASM 모듈을 로드할 수 없습니다. python -m http.server 등으로 서빙하거나 Pages 빌드를 사용하세요.';
    return false;
  }
  try {
    const { default: createNukeKernel } = await import(assetPaths.wasmModule);
    console.log('Creating WASM Kernel...');
    state.kernel = await createNukeKernel({
      locateFile: (path) => resolveAsset(`wasm/${path}`)
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
    state.kernel.getDirectDests = state.kernel.cwrap('nuke_wasm_get_direct_destinations_json', 'string', ['string']);
    state.kernel.analyzeTracking = state.kernel.cwrap('analyze_tracking', 'string', ['string']);

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
    if (typeof state.kernel.analyzeTracking !== 'function' && typeof state.kernel._analyze_tracking === 'function') {
      state.kernel.analyzeTracking = state.kernel._analyze_tracking;
    }

    state.kernel.initStore();

    // Load main routes/graph blob
    const response = await fetch(assetPaths.wasmBlob);
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
    state.wasmUnavailableReason = '';
    return true;
  } catch (err) {
    console.error('WASM Kernel failed to load:', err);
    state.kernel = null;
    state.wasmUnavailableReason = 'WASM 커널 초기화 실패: ' + (err?.message || err);
    return false;
  }
}

async function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register(assetPaths.serviceWorker, { type: 'module' });
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

const LOCATION_HINTS = [
  { pattern: /(INCHEON|ICN|인천)/i, alias: 'INCHEON' },
  { pattern: /(SEOUL|성남|김포|GMP)/i, alias: 'SEOUL' },
  { pattern: /(LOS.?ANGELES|LAX|엘에이)/i, alias: 'LOSANGELES' },
  { pattern: /(FRANKFURT|FRA|프랑크)/i, alias: 'FRANKFURT' },
  { pattern: /(HONG.?KONG|HKG|홍콩)/i, alias: 'HONGKONG' },
  { pattern: /(SINGAPORE|SIN|싱가포르)/i, alias: 'SINGAPORE' },
  { pattern: /(PUDONG|PVG|상하이|SHANGHAI)/i, alias: 'PUDONG' }
];

// Derived from OpenStreetMap facility names for Korea Post distribution centers.
const KOREA_POST_FACILITY_HINTS = [
  {
    alias: 'INCHEON',
    patterns: [
      /국제우편물류센터/,
      /국제우편\s*물류/,
      /인천국제우편/,
      /international\s+mail\s+logistics\s+center/i
    ]
  },
  {
    alias: 'SEOUL',
    patterns: [
      /서울국제/,
      /서울교환/,
      /서울국제우편/
    ]
  },
  {
    alias: 'DAEGU',
    patterns: [
      /대구우편/,
      /대구고성동/,
      /대구/,
      /daegu/i
    ]
  }
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
  const modeTabs = document.querySelectorAll('[data-mode-tab]');
  const manualPanel = document.querySelector('[data-panel="manual"]');
  const trackingPanel = document.querySelector('[data-panel="tracking"]');
  const mapModeButtons = document.querySelectorAll('.map-mode button');
  const bestFromTitle = document.getElementById('best-from-title');
  const bestToTitle = document.getElementById('best-to-title');
  const bestFromResults = document.getElementById('best-from-results');
  const bestToResults = document.getElementById('best-to-results');
  const bestFromRefreshBtn = document.getElementById('best-from-refresh-btn');
  const bestToRefreshBtn = document.getElementById('best-to-refresh-btn');
  const bestFromContinentSelect = document.getElementById('best-from-continent');
  const bestToContinentSelect = document.getElementById('best-to-continent');
  const mapModal = document.getElementById('map-modal');
  const modalCanvas = document.getElementById('route-map-large');
  const modalCloseBtn = document.getElementById('map-modal-close');
  const trackingNumberInput = document.getElementById('tracking-number');
  const trackingFetchBtn = document.getElementById('tracking-fetch-btn');
  const trackingLogInput = document.getElementById('tracking-log-input');
  const trackingAnalyzeBtn = document.getElementById('tracking-analyze-btn');
  const trackingStatus = document.getElementById('tracking-status');
  const trackingMetrics = document.getElementById('tracking-metrics');
  const trackingTimeline = document.getElementById('tracking-timeline');

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
  const touchState = { touches: [], initialDistance: 0, initialZoom: 1 };
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
      if (state.nativeMode) {
        data = await fetchJsonOrError('./airports?limit=8192');
      } else {
        // Try SW-intercepted endpoint first; fall back to direct JSON file
        // when the service worker is not yet controlling this page (first visit).
        const swControlling = !!navigator.serviceWorker?.controller;
        if (swControlling) {
          try {
            data = await fetchJsonOrError('./airports?limit=8192');
          } catch {
            data = null;
          }
        }
      }
      if (!data || !Array.isArray(data.airports)) {
        const response = await fetch(assetPaths.airportsJson);
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

  function setActivePanel(mode) {
    state.uiMode = mode;
    modeTabs.forEach(tab => {
      const isActive = tab.dataset.modeTab === mode;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    if (manualPanel) manualPanel.classList.toggle('hidden', mode !== 'manual');
    if (trackingPanel) trackingPanel.classList.toggle('hidden', mode !== 'tracking');
  }

  function setTrackingStatus(message, variant = 'info') {
    if (!trackingStatus) return;
    trackingStatus.textContent = message;
    trackingStatus.classList.remove('error', 'success');
    if (variant === 'error') trackingStatus.classList.add('error');
    if (variant === 'success') trackingStatus.classList.add('success');
  }

  async function enableNativeMode() {
    try {
      const data = await fetchJsonOrError('./health');
      state.nativeMode = true;
      state.nativeHealth = data;
      state.wasmUnavailableReason = '';
      if (typeof data.airports_loaded === 'number' && statAirports) {
        statAirports.textContent = data.airports_loaded.toLocaleString();
      }
      if (typeof data.routes_loaded === 'number' && statRoutes) {
        statRoutes.textContent = data.routes_loaded.toLocaleString();
      }
      if (typeof data.worker_threads === 'number' && statWorkers) {
        statWorkers.textContent = `Native C (${data.worker_threads})`;
      } else if (statWorkers) {
        statWorkers.textContent = 'Native C 엔진';
      }
      return true;
    } catch (err) {
      console.warn('Native fallback unavailable:', err);
      return false;
    }
  }

  function applyWasmDisabledUi(messageOverride) {
    if (state.nativeMode) return;
    const reason = messageOverride || getWasmUnavailableMessage('이 환경에서는 WASM 기능을 사용할 수 없습니다.');
    const controls = [searchBtn, trackingAnalyzeBtn, bestFromRefreshBtn, bestToRefreshBtn];
    controls.forEach((btn) => {
      if (!btn) return;
      btn.disabled = true;
      btn.title = reason;
      btn.classList.add('disabled');
    });
    if (resultsEl) resultsEl.innerHTML = `<div class="empty-state">${reason}</div>`;
    if (bestFromResults) bestFromResults.innerHTML = `<div class="empty-state">${reason}</div>`;
    if (bestToResults) bestToResults.innerHTML = `<div class="empty-state">${reason}</div>`;
    if (trackingMetrics) trackingMetrics.innerHTML = `<div class="empty-state">${reason}</div>`;
    if (trackingStatus) setTrackingStatus(reason, 'error');
    if (statWorkers) statWorkers.textContent = '로컬 모드';
  }

  function matchKoreaPostFacility(candidate) {
    if (!candidate) return '';
    for (const hint of KOREA_POST_FACILITY_HINTS) {
      if (hint.patterns.some((pattern) => pattern.test(candidate))) {
        return hint.alias;
      }
    }
    return '';
  }

  function normalizeTrackingLocation(name, code, isoCode) {
    const normalizedIso = (isoCode || '').trim().toUpperCase();
    const candidates = [code, name, normalizedIso].filter(Boolean);
    for (const candidate of candidates) {
      const facilityAlias = matchKoreaPostFacility(candidate);
      if (facilityAlias) return facilityAlias;
      for (const hint of LOCATION_HINTS) {
        if (hint.pattern.test(candidate)) return hint.alias;
      }
      const cleaned = candidate.replace(/[^A-Za-z]/g, '').toUpperCase();
      if (cleaned.length >= 6) return cleaned.slice(0, 6);
      if (cleaned.length === 3) return cleaned;
    }
    if (normalizedIso.length === 2) return normalizedIso;
    return '';
  }

  const DEFAULT_TRACKING_TZ_OFFSET_MINUTES = 9 * 60; // Korea Post uses KST (UTC+9) for compact timestamps

  function parseCompactTimestamp(value, offsetMinutes = DEFAULT_TRACKING_TZ_OFFSET_MINUTES) {
    if (value === null || value === undefined) return null;
    const digits = String(value).trim().replace(/\D/g, '');
    if (digits.length !== 12 && digits.length !== 14) return null;
    const year = parseInt(digits.slice(0, 4), 10);
    const month = parseInt(digits.slice(4, 6), 10);
    const day = parseInt(digits.slice(6, 8), 10);
    const hour = parseInt(digits.slice(8, 10), 10);
    const minute = parseInt(digits.slice(10, 12), 10);
    const second = digits.length === 14 ? parseInt(digits.slice(12, 14), 10) : 0;
    if ([year, month, day, hour, minute, second].some((n) => Number.isNaN(n))) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const base = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (Number.isNaN(base.getTime())) return null;
    if (typeof offsetMinutes === 'number' && Number.isFinite(offsetMinutes)) {
      base.setUTCMinutes(base.getUTCMinutes() - offsetMinutes);
    }
    return base;
  }

  function parseDateCandidate(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date;
    }
    const direct = new Date(value);
    if (!Number.isNaN(direct.getTime())) return direct;
    return parseCompactTimestamp(value);
  }

  function resolveKoreaPostCarriers(invoice) {
    const normalized = (invoice || '').trim().toUpperCase();
    const carriers = [];
    const pushUnique = (id, label) => {
      if (!carriers.some(entry => entry.id === id)) {
        carriers.push({ id, label });
      }
    };
    const intlPattern = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
    const domesticPattern = /^\d{13}$/;
    if (intlPattern.test(normalized)) {
      pushUnique('kr.epost.ems', 'Korea Post EMS');
      pushUnique('kr.epost', 'Korea Post');
      pushUnique('un.upu.ems', 'UPU EMS (fallback)');
    } else if (domesticPattern.test(normalized) || normalized.startsWith('KR')) {
      pushUnique('kr.epost', 'Korea Post');
      pushUnique('kr.epost.ems', 'Korea Post EMS');
    } else {
      pushUnique('kr.epost.ems', 'Korea Post EMS');
      pushUnique('kr.epost', 'Korea Post');
    }
    return carriers;
  }

  function getEventDate(progress) {
    const candidates = [
      progress?.time,
      progress?.timeUtc,
      progress?.timeKst,
      progress?.timestamp,
      progress?.date,
      progress?.registerDate
    ];
    for (const raw of candidates) {
      const parsed = parseDateCandidate(raw);
      if (parsed) return parsed;
    }
    if (progress?.date && progress?.time) {
      const combined = parseDateCandidate(`${progress.date} ${progress.time}`);
      if (combined) return combined;
    }
    return null;
  }

  function formatTimelineTime(date) {
    if (!(date instanceof Date)) return '--';
    const pad = (val) => String(val).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatTimestampToken(date) {
    if (!(date instanceof Date)) return '';
    const pad = (val) => String(val).padStart(2, '0');
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
  }

  function enrichTrackingEvents(rawEvents) {
    if (!Array.isArray(rawEvents)) return [];
    return rawEvents.map(progress => {
      const location = progress?.location?.name || progress?.location?.display || progress?.location || progress?.officeName || '';
      const code = progress?.location?.code || progress?.code || '';
      const countryCode = (progress?.location?.countryCode || progress?.countryCode || progress?.country || '').toString().trim().toUpperCase();
      const alias = normalizeTrackingLocation(location, code, countryCode);
      const date = getEventDate(progress);
      const token = formatTimestampToken(date);
      if (!alias || !token) return null;
      return {
        alias,
        countryCode,
        locationName: location ? (countryCode ? `${location} (${countryCode})` : location) : (countryCode || alias),
        statusText: progress?.status?.text || progress?.description || progress?.message || '',
        statusCode: progress?.status?.code || '',
        timestampToken: token,
        displayTime: formatTimelineTime(date),
        raw: progress
      };
    }).filter(Boolean);
  }

  async function fetchTrackingEvents(invoice, candidateOverride) {
    const candidates = Array.isArray(candidateOverride) && candidateOverride.length
      ? candidateOverride
      : resolveKoreaPostCarriers(invoice);
    const attemptErrors = [];
    for (const carrier of candidates) {
      const endpoint = `${TRACKER_DELIVERY_API}/carriers/${carrier.id}/tracks/${encodeURIComponent(invoice)}`;
      try {
        const headers = { 'Accept': 'application/json' };
        if (TRACKER_API_KEY) {
          headers['X-Tracker-API-Key'] = TRACKER_API_KEY;
        }
        const response = await fetch(endpoint, {
          headers,
          mode: 'cors'
        });
        const rawBody = await response.text();
        if (!response.ok) {
          let detail = '';
          try {
            const parsed = rawBody ? JSON.parse(rawBody) : null;
            detail = parsed?.message || '';
          } catch (_) {
            detail = rawBody?.trim();
          }
          throw new Error(detail ? `HTTP ${response.status} ${detail}` : `HTTP ${response.status}`);
        }
        let data = {};
        try {
          data = rawBody ? JSON.parse(rawBody) : {};
        } catch (err) {
          throw new Error('JSON 파싱 실패');
        }
        const progresses = Array.isArray(data?.progresses) ? data.progresses : [];
        if (!progresses.length) {
          throw new Error('진행 이벤트가 비어 있습니다.');
        }
        return progresses;
      } catch (err) {
        attemptErrors.push(`${carrier.label}: ${err.message}`);
      }
    }
    const joined = attemptErrors.length ? attemptErrors.join(' / ') : '알 수 없는 오류';
    throw new Error(`우체국 API에 연결하지 못했습니다. ${joined} · 로그를 직접 붙여넣을 수 있습니다.`);
  }

  function buildTrackingPayload(events) {
    if (!events.length) return '';
    return events.map(evt => `${evt.alias} ${evt.timestampToken} ${evt.statusText || ''}`.trim()).join('\n');
  }

  function renderTrackingMetrics(result) {
    if (!trackingMetrics) return;
    if (!result || typeof result !== 'object') {
      trackingMetrics.innerHTML = '<div class="empty-state">분석 결과가 없습니다.</div>';
      return;
    }
    const formatPercent = (value) => (value * 100).toFixed(1) + '%';
    trackingMetrics.innerHTML = `
      <div class="metric">
        <span>경유 노드</span>
        <strong>${result.nodes ?? '--'}</strong>
      </div>
      <div class="metric">
        <span>직선 거리</span>
        <strong>${result.directKm?.toFixed ? result.directKm.toFixed(1) + ' km' : '--'}</strong>
      </div>
      <div class="metric">
        <span>실제 이동</span>
        <strong>${result.traveledKm?.toFixed ? result.traveledKm.toFixed(1) + ' km' : '--'}</strong>
      </div>
      <div class="metric">
        <span>경로 페널티</span>
        <strong>${result.routePenalty !== undefined ? formatPercent(result.routePenalty) : '--'}</strong>
      </div>
      <div class="metric">
        <span>대기 페널티</span>
        <strong>${result.dwellPenalty !== undefined ? formatPercent(result.dwellPenalty) : '--'}</strong>
      </div>
      <div class="metric">
        <span>EDI 스코어</span>
        <strong>${result.idiotScore !== undefined ? result.idiotScore.toFixed(1) : '--'}</strong>
      </div>
    `;
  }

  function renderTrackingTimeline(events) {
    if (!trackingTimeline) return;
    if (!events.length) {
      trackingTimeline.innerHTML = '<div class="empty-state">우체국 이벤트가 없습니다.</div>';
      return;
    }
    trackingTimeline.innerHTML = events.map(evt => {
      const tags = [];
      if (evt.alias) tags.push(evt.alias);
      if (evt.countryCode && evt.countryCode !== evt.alias) tags.push(evt.countryCode);
      return `
      <div class="timeline-item">
        <div class="timeline-time">${evt.displayTime}</div>
        <div class="timeline-details">
          <strong>${evt.locationName}</strong>
          <span>${evt.statusText || ''}</span>
          ${tags.map(tag => `<span class="tag">${tag}</span>`).join('')}
        </div>
      </div>
    `;
    }).join('');
  }

  async function runTrackingAnalysis(rawText) {
    if (!trackingLogInput || !trackingStatus) return;
    const payload = (rawText || '').trim();
    if (!payload) {
      setTrackingStatus('분석할 이벤트 문자열이 없습니다.', 'error');
      return;
    }
    if (state.kernel && typeof state.kernel.analyzeTracking === 'function') {
      try {
        const result = JSON.parse(state.kernel.analyzeTracking(payload));
        renderTrackingMetrics(result);
        setTrackingStatus(`분석 완료: EDI ${result.idiotScore?.toFixed ? result.idiotScore.toFixed(1) : '--'}`, 'success');
      } catch (err) {
        setTrackingStatus('분석 실패: ' + err.message, 'error');
      }
      return;
    }
    if (state.nativeMode) {
      try {
        setTrackingStatus('서버 분석 중...');
        const result = await analyzeTrackingNative(payload);
        renderTrackingMetrics(result);
        setTrackingStatus(`분석 완료: EDI ${result.idiotScore?.toFixed ? result.idiotScore.toFixed(1) : '--'}`, 'success');
      } catch (err) {
        setTrackingStatus('분석 실패: ' + err.message, 'error');
      }
      return;
    }
    setTrackingStatus(getWasmUnavailableMessage(), 'error');
  }

  async function handleTrackingFetch() {
    if (!trackingNumberInput) return;
    const invoice = trackingNumberInput.value.trim();
    if (!invoice) {
      setTrackingStatus('송장번호를 입력하세요.', 'error');
      trackingNumberInput.focus();
      return;
    }
    const carriers = resolveKoreaPostCarriers(invoice);
    const carrierLabels = carriers.map(c => c.label).join(', ');
    setTrackingStatus(`한국 우체국 (${carrierLabels})에서 조회 중...`);
    try {
      const rawEvents = await fetchTrackingEvents(invoice, carriers);
      const events = enrichTrackingEvents(rawEvents);
      state.trackingEvents = events;
      if (!events.length) {
        setTrackingStatus('파싱 가능한 공항 이벤트를 찾지 못했습니다. 로그를 직접 붙여넣어 주세요.', 'error');
        renderTrackingTimeline([]);
        return;
      }
      renderTrackingTimeline(events);
      const payload = buildTrackingPayload(events);
      if (trackingLogInput) trackingLogInput.value = payload;
      await runTrackingAnalysis(payload);
    } catch (err) {
      setTrackingStatus(err.message || '조회 실패', 'error');
      renderTrackingTimeline([]);
    }
  }

  async function runRouteSearch(from, to, maxTransfers, maxResults) {
    if (state.kernel) {
      const data = JSON.parse(state.kernel.searchRoutes(from, to, maxTransfers));
      if (Array.isArray(data.paths) && maxResults) {
        data.paths = data.paths.slice(0, maxResults);
      }
      return data;
    }
    if (state.nativeMode) {
      return fetchNativeRoutes(from, to, maxTransfers, maxResults || 16);
    }
    throw new Error(getWasmUnavailableMessage());
  }

  async function searchRoutes() {
    const from = fromInput.value.trim().toUpperCase();
    const to = toInput.value.trim().toUpperCase();
    if (from.length !== 3 || to.length !== 3) return;
    const transfersRaw = transfersInput ? parseInt(transfersInput.value, 10) : 0;
    const resultsRaw = resultsInput ? parseInt(resultsInput.value, 10) : 8;
    const maxT = clampNumber(transfersRaw || 0, 0, 5);
    const maxResults = clampNumber(resultsRaw || 8, 1, 64);
    if (!state.kernel && !state.nativeMode) {
      statusEl.textContent = getWasmUnavailableMessage('경로 엔진이 준비되지 않았습니다.');
      return;
    }
    statusEl.textContent = state.kernel ? 'WASM 분석 중...' : '서버 분석 중...';
    try {
      const data = await runRouteSearch(from, to, maxT, maxResults);
      const paths = Array.isArray(data.paths) ? data.paths.slice(0, maxResults) : [];
      state.routes = paths;
      resultsEl.innerHTML = paths.length ? paths.map((p, i) => `
        <div class="result-card">
          <h3>경로 ${i + 1}: ${p.airports.map(a => a.code).join(' → ')}</h3>
          <p>${p.legs}구간 · ${p.totalDistanceKm.toFixed(1)}km · 효율 ${p.efficiency.toFixed(3)}</p>
        </div>
      `).join('') : '<div class="empty-state">경로 없음</div>';
      statusEl.textContent = `분석 완료: ${paths.length}개 발견`;
      drawAllScenes();
    } catch (err) {
      statusEl.textContent = '오류: ' + err.message;
      resultsEl.innerHTML = `<div class="empty-state">${err.message}</div>`;
    }
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

  // Touch gesture handlers for mobile pinch-to-zoom
  function getTouchDistance(touch1, touch2) {
    const dx = touch2.clientX - touch1.clientX;
    const dy = touch2.clientY - touch1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function handleTouchStart(canvas, e) {
    if (!state.isMobile) return;
    touchState.touches = Array.from(e.touches);
    if (touchState.touches.length === 2) {
      e.preventDefault();
      touchState.initialDistance = getTouchDistance(touchState.touches[0], touchState.touches[1]);
      touchState.initialZoom = view.zoom;
    }
  }

  function handleTouchMove(canvas, e) {
    if (!state.isMobile) return;
    if (e.touches.length === 2) {
      e.preventDefault();
      const currentDistance = getTouchDistance(e.touches[0], e.touches[1]);
      const scale = currentDistance / touchState.initialDistance;
      view.zoom = Math.min(view.maxZoom, Math.max(view.minZoom, touchState.initialZoom * scale));
      clampViewCenter();
      drawAllScenes();
    }
  }

  function handleTouchEnd(canvas, e) {
    if (!state.isMobile) return;
    touchState.touches = Array.from(e.touches);
    if (touchState.touches.length < 2) {
      touchState.initialDistance = 0;
      touchState.initialZoom = view.zoom;
    }
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

  function setupTouchGestures() {
    if (state.isMobile) {
      [mainCanvas, modalCanvas].forEach(canvas => {
        canvas.addEventListener('touchstart', (e) => handleTouchStart(canvas, e), { passive: false });
        canvas.addEventListener('touchmove', (e) => handleTouchMove(canvas, e), { passive: false });
        canvas.addEventListener('touchend', (e) => handleTouchEnd(canvas, e), { passive: false });
      });
    }
  }

  modalCloseBtn.addEventListener('click', closeMapModal);
  mapModal.addEventListener('click', (e) => { if (e.target === mapModal) closeMapModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mapModal.classList.contains('open')) closeMapModal(); });

  swapBtn.addEventListener('click', () => { const f = fromInput.value, t = toInput.value; setInputField('from', t); setInputField('to', f); });
  mapModeButtons.forEach(b => b.addEventListener('click', () => { mapModeButtons.forEach(x => x.classList.remove('active')); b.classList.add('active'); state.activeField = b.dataset.field; }));
  searchBtn.addEventListener('click', () => { searchRoutes().catch(err => console.error(err)); });
  modeTabs.forEach(tab => tab.addEventListener('click', () => setActivePanel(tab.dataset.modeTab || 'manual')));
  if (trackingFetchBtn) trackingFetchBtn.addEventListener('click', () => { handleTrackingFetch().catch(err => console.error(err)); });
  if (trackingAnalyzeBtn && trackingLogInput) trackingAnalyzeBtn.addEventListener('click', () => { runTrackingAnalysis(trackingLogInput.value).catch(err => console.error(err)); });
  if (trackingNumberInput) {
    trackingNumberInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleTrackingFetch();
      }
    });
  }
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
        strong.textContent = '#' + (i + 1) + ' ' + dest.code + (dest.country ? ' (' + dest.country + ')' : '');
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

  function getContinent(lat, lon) {
    if (lat >= 7 && lat <= 84 && lon >= -170 && lon <= -50) return '북미';
    if (lat < 7 && lat >= -60 && lon >= -100 && lon <= -30) return '남미';
    if (lat < -15 && lon >= 100 && lon <= 180) return '오세아니아';
    if (lat >= 12 && lat <= 42 && lon >= 25 && lon <= 63) return '중동';
    if (lat >= 35 && lon >= -15 && lon <= 60) return '유럽';
    if (lat < 35 && lat >= -40 && lon >= -20 && lon <= 55) return '아프리카';
    if (lat >= -15 && lon > 55 && lon <= 180) return '아시아';
    if (lat >= 5 && lon >= 25 && lon <= 180) return '아시아';
    return '기타';
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371.0;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Hardcoded route restrictions (mirrors server-side logistics_restrictions)
  const ROUTE_RESTRICTIONS = [
    { origin: 'ICN', destination: 'FNJ' },
    { origin: 'FNJ', destination: 'ICN' },
    { origin: 'SVO', destination: 'KBP' },
    { origin: 'KBP', destination: 'SVO' }
  ];

  function getForbiddenCountries(originCode) {
    const countries = new Set();
    for (const rule of ROUTE_RESTRICTIONS) {
      if (rule.origin !== originCode) continue;
      const dest = state.airportMap.get(rule.destination);
      if (dest && dest.country) countries.add(dest.country);
    }
    return countries;
  }

  function computeBestDestinationsLocal(originCode, continentFilter) {
    if (!state.kernel || state.airports.length === 0) return {};
    const origin = state.airportMap.get(originCode);
    if (!origin) return {};
    const filterContinent = continentFilter || getContinent(origin.lat, origin.lon);
    const originCountry = origin.country || '';
    const forbiddenCountries = getForbiddenCountries(originCode);

    // --- Tier 1: Spatial filtering (500km / 1000km bounding box) ---
    const tier1Near = [];
    const tier1Far = [];
    for (const a of state.airports) {
      if (a.code === originCode) continue;
      if (getContinent(a.lat, a.lon) !== filterContinent) continue;
      // Skip domestic (same-country) destinations
      if (originCountry && a.country && a.country === originCountry) continue;
      // Skip destinations in forbidden countries
      if (a.country && forbiddenCountries.has(a.country)) continue;
      const dist = haversineKm(origin.lat, origin.lon, a.lat, a.lon);
      if (dist <= 500) tier1Near.push(a);
      else if (dist <= 1000) tier1Far.push(a);
    }

    // --- Tier 2: Hub-to-hub direct flights ---
    const tier2Hubs = [];
    if (state.kernel.getDirectDests) {
      try {
        const directData = JSON.parse(state.kernel.getDirectDests(originCode));
        const directDests = directData.destinations || [];
        const HUB_MIN_CONNECTIONS = 30;
        for (const d of directDests) {
          if (getContinent(d.lat, d.lon) !== filterContinent) continue;
          // Skip domestic (same-country) destinations
          const existing = state.airportMap.get(d.code);
          const destCountry = d.country || existing?.country || '';
          if (originCountry && destCountry && destCountry === originCountry) continue;
          // Skip destinations in forbidden countries
          if (destCountry && forbiddenCountries.has(destCountry)) continue;
          if (d.connections >= HUB_MIN_CONNECTIONS) {
            if (existing) tier2Hubs.push(existing);
          }
        }
      } catch { /* skip */ }
    }

    // --- Merge and deduplicate ---
    const seen = new Set();
    const candidates = [];
    for (const list of [tier1Near, tier2Hubs, tier1Far]) {
      for (const a of list) {
        if (!seen.has(a.code)) {
          seen.add(a.code);
          candidates.push(a);
        }
      }
    }

    if (candidates.length < 20) {
      const remaining = state.airports.filter(a => {
        if (a.code === originCode || seen.has(a.code)) return false;
        // Skip domestic (same-country) destinations
        if (originCountry && a.country && a.country === originCountry) return false;
        // Skip destinations in forbidden countries
        if (a.country && forbiddenCountries.has(a.country)) return false;
        return getContinent(a.lat, a.lon) === filterContinent;
      });
      for (const a of remaining) {
        if (!seen.has(a.code)) {
          seen.add(a.code);
          candidates.push(a);
        }
        if (candidates.length >= 200) break;
      }
    }

    const sample = candidates.length > 200 ? candidates.slice(0, 200) : candidates;

    // --- Search and score with country-unique top 5 ---
    const seenCountries = new Set();
    const continentResults = {};
    const MAX_COUNTRIES = 5;

    for (const dest of sample) {
      if (seenCountries.size >= MAX_COUNTRIES) break;

      const destCountry = dest.country || '';

      // Skip domestic (same-country) destinations
      if (originCountry && destCountry && destCountry === originCountry) continue;

      if (destCountry && seenCountries.has(destCountry)) continue;

      try {
        const result = JSON.parse(state.kernel.searchRoutes(originCode, dest.code, 2));
        if (!result.paths || !result.paths.length) continue;
        const path = result.paths[0];
        const dist = path.totalDistanceKm;
        const efficiency = path.efficiency;
        const reliability = efficiency * 100;
        const score = (reliability / (dist + 1)) * 1000;

        const continent = getContinent(dest.lat, dest.lon);
        if (!continentResults[continent]) continentResults[continent] = [];
        continentResults[continent].push({
          code: dest.code,
          lat: dest.lat,
          lon: dest.lon,
          country: destCountry,
          distanceKm: dist,
          efficiency: efficiency,
          score: score,
          hops: path.hops || path.legs || 0,
          route: path.airports ? path.airports.map(a => a.code).join(' → ') : originCode + ' → ' + dest.code
        });

        if (destCountry) seenCountries.add(destCountry);
      } catch { /* skip */ }
    }

    for (const continent of Object.keys(continentResults)) {
      continentResults[continent].sort((a, b) => b.score - a.score);
      const unique = [];
      const countrySeen = new Set();
      for (const item of continentResults[continent]) {
        const c = item.country || item.code;
        if (countrySeen.has(c)) continue;
        countrySeen.add(c);
        unique.push(item);
        if (unique.length >= 5) break;
      }
      continentResults[continent] = unique;
    }
    return continentResults;
  }

  async function computeBestDestinationsNative(originCode, continentFilter) {
    if (!state.nativeMode || state.airports.length === 0) return {};
    const origin = state.airportMap.get(originCode);
    if (!origin) return {};
    const filterContinent = continentFilter || getContinent(origin.lat, origin.lon);
    const originCountry = origin.country || '';
    const forbiddenCountries = getForbiddenCountries(originCode);

    const tier1Near = [];
    const tier1Far = [];
    for (const a of state.airports) {
      if (a.code === originCode) continue;
      if (getContinent(a.lat, a.lon) !== filterContinent) continue;
      if (originCountry && a.country && a.country === originCountry) continue;
      if (a.country && forbiddenCountries.has(a.country)) continue;
      const dist = haversineKm(origin.lat, origin.lon, a.lat, a.lon);
      if (dist <= 500) tier1Near.push(a);
      else if (dist <= 1000) tier1Far.push(a);
    }

    const tier2Hubs = [];
    try {
      const directData = await fetchNativeDirectDestinations(originCode);
      const directDests = Array.isArray(directData.destinations) ? directData.destinations : [];
      const HUB_MIN_CONNECTIONS = 30;
      for (const d of directDests) {
        if (getContinent(d.lat, d.lon) !== filterContinent) continue;
        const existing = state.airportMap.get(d.code);
        const destCountry = d.country || existing?.country || '';
        if (originCountry && destCountry && destCountry === originCountry) continue;
        if (destCountry && forbiddenCountries.has(destCountry)) continue;
        if (d.connections >= HUB_MIN_CONNECTIONS) {
          if (existing) tier2Hubs.push(existing);
          else tier2Hubs.push({ code: d.code, lat: d.lat, lon: d.lon, country: destCountry });
        }
      }
    } catch (err) {
      console.warn('Direct destinations unavailable:', err);
    }

    const seen = new Set();
    const candidates = [];
    for (const list of [tier1Near, tier2Hubs, tier1Far]) {
      for (const a of list) {
        if (!seen.has(a.code)) {
          seen.add(a.code);
          candidates.push(a);
        }
      }
    }

    if (candidates.length < 20) {
      const remaining = state.airports.filter(a => {
        if (a.code === originCode || seen.has(a.code)) return false;
        if (originCountry && a.country && a.country === originCountry) return false;
        if (a.country && forbiddenCountries.has(a.country)) return false;
        return getContinent(a.lat, a.lon) === filterContinent;
      });
      for (const a of remaining) {
        if (!seen.has(a.code)) {
          seen.add(a.code);
          candidates.push(a);
        }
        if (candidates.length >= 200) break;
      }
    }

    const sample = candidates.length > 200 ? candidates.slice(0, 200) : candidates;
    const continentResults = {};
    const seenCountries = new Set();
    const MAX_COUNTRIES = 5;

    for (const dest of sample) {
      if (seenCountries.size >= MAX_COUNTRIES) break;
      const destCountry = dest.country || '';
      if (originCountry && destCountry && destCountry === originCountry) continue;
      if (destCountry && seenCountries.has(destCountry)) continue;
      try {
        const result = await runRouteSearch(originCode, dest.code, 2, 1);
        if (!result.paths || !result.paths.length) continue;
        const path = result.paths[0];
        const dist = path.totalDistanceKm;
        const efficiency = path.efficiency;
        const reliability = efficiency * 100;
        const score = (reliability / (dist + 1)) * 1000;
        const continent = getContinent(dest.lat, dest.lon);
        if (!continentResults[continent]) continentResults[continent] = [];
        continentResults[continent].push({
          code: dest.code,
          lat: dest.lat,
          lon: dest.lon,
          country: destCountry,
          distanceKm: dist,
          efficiency: efficiency,
          score: score,
          hops: path.hops || path.legs || 0,
          route: path.airports ? path.airports.map(a => a.code).join(' → ') : originCode + ' → ' + dest.code
        });
        if (destCountry) seenCountries.add(destCountry);
      } catch (err) {
        // Ignore failures for individual destinations
      }
    }

    for (const continent of Object.keys(continentResults)) {
      continentResults[continent].sort((a, b) => b.score - a.score);
      const unique = [];
      const countrySeen = new Set();
      for (const item of continentResults[continent]) {
        const c = item.country || item.code;
        if (countrySeen.has(c)) continue;
        countrySeen.add(c);
        unique.push(item);
        if (unique.length >= 5) break;
      }
      continentResults[continent] = unique;
    }
    return continentResults;
  }

  async function computeBestDestinations(originCode, continentFilter) {
    if (state.kernel) {
      return computeBestDestinationsLocal(originCode, continentFilter);
    }
    if (state.nativeMode) {
      return computeBestDestinationsNative(originCode, continentFilter);
    }
    throw new Error(getWasmUnavailableMessage('경로 엔진이 준비되지 않았습니다.'));
  }

  async function requestBestFrom() {
    const fromCode = fromInput.value.trim().toUpperCase();
    if (fromCode.length !== 3 || !state.airportMap.has(fromCode)) {
      bestFromResults.innerHTML = '<div class="empty-state">유효한 3자리 IATA 코드를 입력하세요.</div>';
      return;
    }
    const continent = bestFromContinentSelect ? bestFromContinentSelect.value : '';
    const origin = state.airportMap.get(fromCode);
    const label = continent || (origin ? getContinent(origin.lat, origin.lon) : '');
    bestFromTitle.textContent = fromCode + '에서 최적 목적지' + (label ? ' (' + label + ')' : '');
    bestFromResults.classList.add('loading');
    bestFromResults.innerHTML = '<div class="empty-state">계산 중...</div>';
    if (state.bestWorker) {
      const airports = state.airports.map(a => ({ code: a.code, lat: a.lat, lon: a.lon, country: a.country || '' }));
      state.bestRequestId++;
      state.bestWorker.postMessage({ type: 'compute', id: state.bestRequestId, originCode: fromCode, airports, continent });
    } else {
      try {
        const data = await computeBestDestinations(fromCode, continent);
        renderBestDestinations(bestFromResults, data);
      } catch (err) {
        bestFromResults.innerHTML = `<div class="empty-state">${err.message}</div>`;
      }
      bestFromResults.classList.remove('loading');
    }
  }

  async function requestBestTo() {
    const toCode = toInput.value.trim().toUpperCase();
    if (toCode.length !== 3 || !state.airportMap.has(toCode)) {
      bestToResults.innerHTML = '<div class="empty-state">유효한 3자리 IATA 코드를 입력하세요.</div>';
      return;
    }
    const continent = bestToContinentSelect ? bestToContinentSelect.value : '';
    const origin = state.airportMap.get(toCode);
    const label = continent || (origin ? getContinent(origin.lat, origin.lon) : '');
    bestToTitle.textContent = toCode + '에서 최적 목적지' + (label ? ' (' + label + ')' : '');
    bestToResults.classList.add('loading');
    bestToResults.innerHTML = '<div class="empty-state">계산 중...</div>';
    if (state.bestWorker) {
      const airports = state.airports.map(a => ({ code: a.code, lat: a.lat, lon: a.lon, country: a.country || '' }));
      state.bestRequestId++;
      state.bestWorker.postMessage({ type: 'compute', id: state.bestRequestId, originCode: toCode, airports, continent });
    } else {
      try {
        const data = await computeBestDestinations(toCode, continent);
        renderBestDestinations(bestToResults, data);
      } catch (err) {
        bestToResults.innerHTML = `<div class="empty-state">${err.message}</div>`;
      }
      bestToResults.classList.remove('loading');
    }
  }

  async function init() {
    // Detect mobile device
    state.isMobile = detectMobile();
    
    // Setup touch gestures for mobile devices (must be after mobile detection)
    setupTouchGestures();
    
    await initServiceWorker();
    const wasmReady = await initWasm();
    let nativeReady = false;
    if (!wasmReady) {
      nativeReady = await enableNativeMode();
      if (!nativeReady) {
        applyWasmDisabledUi();
      }
    }
    await fetchAirports();

    if (wasmReady) {
      // Start the best-destinations Web Worker (separate WASM instance)
      try {
        state.bestWorker = new Worker(assetPaths.workerScript, { type: 'module' });
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
    }

    if (wasmReady && state.kernel) {
      const h = JSON.parse(state.kernel.getHealth());
      statRoutes.textContent = h.routes_loaded.toLocaleString();
      statWorkers.textContent = 'WASM-Serverless';
    } else if (state.nativeMode && state.nativeHealth) {
      if (statRoutes && typeof state.nativeHealth.routes_loaded === 'number') {
        statRoutes.textContent = state.nativeHealth.routes_loaded.toLocaleString();
      }
    } else if (statRoutes) {
      statRoutes.textContent = '--';
    }
  }

  bestFromRefreshBtn.addEventListener('click', () => { requestBestFrom().catch(err => console.error(err)); });
  bestToRefreshBtn.addEventListener('click', () => { requestBestTo().catch(err => console.error(err)); });

  setActivePanel(state.uiMode || 'manual');
  resizeAllCanvases();
  init();
});
