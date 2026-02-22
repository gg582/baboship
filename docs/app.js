const state = {
  nodes: [], // Renamed from airports
  nodeMap: new Map(), // Renamed from airportMap
  routes: [],
  activeField: 'from',
  selection: { from: null, to: null },
  best: [],
  kernel: null,
  bestWorker: null,
  bestRequestId: 0,
  isMobile: false,
  uiMode: 'manual',
  trackingEventsIntl: [],
  domesticTrackingEvents: [],
  wasmUnavailableReason: '',
  nativeMode: false,
  nativeHealth: null,
  nativeDirectCache: new Map()
};

// Global MapLibre map objects
let mainMapLibre = null;
let modalMapLibre = null;

const MapLayerStyle = {
  NODE_CIRCLE: {
    id: 'nodes-circle',
    type: 'circle',
    source: 'nodes',
    paint: {
      'circle-color': [
        'match',
        ['get', 'layer'],
        'air', '#3399FF',
        'sea', '#66BB6A',
        '#FF3333' // Default for 'land' or unknown
      ],
      'circle-radius': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 8,
        ['boolean', ['feature-state', 'hover'], false], 6,
        4
      ],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1
    }
  },
  NODE_SYMBOL: {
    id: 'nodes-symbol',
    type: 'symbol',
    source: 'nodes',
    layout: {
      'text-field': ['get', 'code'],
      'text-font': ['IBM Plex Sans KR Medium', 'Arial Unicode MS Regular'],
      'text-size': 10,
      'text-offset': [0, 1],
      'text-anchor': 'top'
    },
    paint: {
      'text-color': '#fff',
      'text-halo-color': '#000',
      'text-halo-width': 1
    }
  },
  ROUTE_LINE_HIGHLIGHT: {
    id: 'routes-line-highlight',
    type: 'line',
    source: 'routes',
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': '#FFD700', // Gold for highlight
      'line-width': 4,
      'line-opacity': 0.75
    },
    filter: ['==', ['get', 'id'], ''] // Hidden by default
  },
  ROUTE_LINE: {
    id: 'routes-line',
    type: 'line',
    source: 'routes',
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': [
        'match',
        ['get', 'layer'],
        'air', '#22d3ee', // Cyan
        'sea', '#5eead4', // Teal
        '#FF3333' // Red for 'land' or unknown
      ],
      'line-width': 2,
      'line-opacity': 0.6
    }
  },
  ORS_ROUTE_LINE: { // New style for ORS road-based route
    id: 'ors-route-line',
    type: 'line',
    source: 'ors-route',
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': '#FF8C00', // Dark Orange
      'line-width': 3,
      'line-opacity': 0.8
    }
  }
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
  // airportsJson: resolveAsset('airports.json'), // Removed - now fetched via WASM kernel
  serviceWorker: resolveAsset('sw.js')
};

const trackerConfig = (typeof window !== 'undefined' && window.__baboship_config) ? window.__baboship_config : {};
const TRACKER_DELIVERY_API = trackerConfig.trackerApiBase || 'https://apis.tracker.delivery';
const TRACKER_API_KEY = trackerConfig.trackerApiKey || '';

const ORS_API_KEY = trackerConfig.orsApiKey || ''; // Placeholder for ORS API Key
const ORS_BASE_URL = 'https://api.openrouteservice.org/v2/directions/driving-car'; // ORS Directions API

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

async function fetchORSPath(originCoords, destCoords) {
  if (!ORS_API_KEY) {
    console.warn('ORS_API_KEY is not set. Cannot fetch road path.');
    return null;
  }
  const url = `${ORS_BASE_URL}?api_key=${ORS_API_KEY}&start=${originCoords.lon},${originCoords.lat}&end=${destCoords.lon},${destCoords.lat}`;
  try {
    const data = await fetchJsonOrError(url, { method: 'GET' });
    if (data.features && data.features.length > 0) {
      // The first feature should contain the main route geometry
      return {
        geojson: data.features[0].geometry,
        distance: data.features[0].properties.summary.distance, // meters
        duration: data.features[0].properties.summary.duration  // seconds
      };
    }
  } catch (err) {
    console.error('Failed to fetch ORS path:', err);
    return null;
  }
  return null;
}

// Mobile device detection
function detectMobile() {
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isMobileScreen = window.innerWidth <= 768;
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
    state.kernel.getNodes = state.kernel.cwrap('nuke_wasm_get_nodes_json', 'string', []); // Changed from getAirports
    state.kernel.getBest = state.kernel.cwrap('nuke_wasm_get_best_nodes_json', 'string', []);
    state.kernel.getHealth = state.kernel.cwrap('nuke_wasm_get_health_json', 'string', []);
    state.kernel.searchRoutes = state.kernel.cwrap('nuke_wasm_search_routes_json', 'string', ['string', 'string', 'number']);
    state.kernel.calcScore = state.kernel.cwrap('nuke_wasm_calc_score', 'number', ['number', 'number', 'number', 'number', 'number']);
    state.kernel.getDirectDests = state.kernel.cwrap('nuke_wasm_get_direct_destinations_json', 'string', ['string']);
    state.kernel.analyzeTracking = state.kernel.cwrap('analyze_tracking', 'string', ['string']);

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
      await navigator.serviceWorker.ready;
      console.log('Service Worker ready at scope:', navigator.serviceWorker.controller?.scriptURL);
    } catch (err) {
      console.warn('Service Worker failed:', err);
    }
  }
}

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

const MAJOR_LOGISTICS_CENTERS = [
  { alias: 'ICN_HUB', keywords: ['인천국제공항', '인천허브', 'ICN'], lat: 37.4692, lon: 126.4505, countryCode: 'KR' },
  { alias: 'GMP_HUB', keywords: ['김포공항', '김포허브', 'GMP'], lat: 37.5582, lon: 126.7915, countryCode: 'KR' },
  { alias: 'PUS_HUB', keywords: ['부산', '김해공항', 'PUS'], lat: 35.1796, lon: 129.0756, countryCode: 'KR' },
  { alias: 'CJJ_HUB', keywords: ['청주공항', '청주', 'CJJ'], lat: 36.7170, lon: 127.4912, countryCode: 'KR' },
  { alias: 'CJU_HUB', keywords: ['제주공항', '제주', 'CJU'], lat: 33.5110, lon: 126.4933, countryCode: 'KR' },
  { alias: 'GWANGJU_HUB', keywords: ['광주', '무안공항', 'KWJ'], lat: 35.1601, lon: 126.8510, countryCode: 'KR' },
  { alias: 'DAEJEON_HUB', keywords: ['대전', '대덕', 'DCC'], lat: 36.3504, lon: 127.3845, countryCode: 'KR' },
  { alias: 'D_HUB_ILSA', keywords: ['CJ대한통운 일산', '일산'], lat: 37.6749, lon: 126.7583, countryCode: 'KR' }, // Example of a specific non-airport hub
  { alias: 'D_HUB_GUNPO', keywords: ['한진택배 군포', '군포'], lat: 37.3601, lon: 126.9360, countryCode: 'KR' }, // Example of a specific non-airport hub
];


document.addEventListener('DOMContentLoaded', () => {
  const mapContainer = document.getElementById('map-container');
  const mapContainerLarge = document.getElementById('map-container-large');
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
  const domesticTrackingPanel = document.querySelector('[data-panel="domestic-tracking"]');
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
  const modalCloseBtn = document.getElementById('map-modal-close');
  const trackingNumberInputIntl = document.getElementById('tracking-number-intl');
  const trackingFetchBtnIntl = document.getElementById('tracking-fetch-btn-intl');
  const trackingLogInputIntl = document.getElementById('tracking-log-input-intl');
  const trackingAnalyzeBtnIntl = document.getElementById('tracking-analyze-btn-intl');
  const trackingStatusIntl = document.getElementById('tracking-status-intl');
  const trackingMetricsIntl = document.getElementById('tracking-metrics-intl');
  const trackingTimelineIntl = document.getElementById('tracking-timeline-intl');

  const trackingNumberInputDomestic = document.getElementById('tracking-number-domestic');
  const carrierSelectDomestic = document.getElementById('carrier-select-domestic');
  const trackingFetchBtnDomestic = document.getElementById('tracking-fetch-btn-domestic');
  const trackingLogInputDomestic = document.getElementById('tracking-log-input-domestic');
  const trackingStatusDomestic = document.getElementById('tracking-status-domestic');
  const trackingMetricsDomestic = document.getElementById('tracking-metrics-domestic');
  const trackingTimelineDomestic = document.getElementById('tracking-timeline-domestic');

  // --- MapLibre GL JS Integration ---
  function initMap(containerId, isModal = false) {
    const map = new maplibregl.Map({
      container: containerId,
      style: 'https://tiles.stadiamaps.com/styles/stadium-dark.json', // Example style, could use OpenFreeMap
      center: [0, 0], // starting position [lng, lat]
      zoom: 1 // starting zoom
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      map.addSource('nodes', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });
      map.addSource('routes', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });
      map.addSource('ors-route', { // New source for ORS road-based route
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });

      map.addLayer(MapLayerStyle.ROUTE_LINE);
      map.addLayer(MapLayerStyle.ROUTE_LINE_HIGHLIGHT);
      map.addLayer(MapLayerStyle.ORS_ROUTE_LINE); // Add the new ORS route layer
      map.addLayer(MapLayerStyle.NODE_CIRCLE);
      map.addLayer(MapLayerStyle.NODE_SYMBOL);

      // Node click handler
      map.on('click', MapLayerStyle.NODE_CIRCLE.id, (e) => {
        if (e.features.length > 0) {
          const clickedNode = e.features[0].properties;
          const node = state.nodeMap.get(clickedNode.code);
          if (node) {
            setInputField(state.activeField, node.code);
          }
        }
      });

      // Change the cursor to a pointer when the mouse is over the nodes-circle layer.
      map.on('mouseenter', MapLayerStyle.NODE_CIRCLE.id, () => {
        map.getCanvas().style.cursor = 'pointer';
      });

      // Change it back to a pointer when it leaves.
      map.on('mouseleave', MapLayerStyle.NODE_CIRCLE.id, () => {
        map.getCanvas().style.cursor = '';
      });
      
      if (!isModal) {
        fetchNodes(); // Call fetchNodes here after main map is loaded
      }
    });

    return map;
  }

  function updateMapNodes(mapInstance) {
    if (!mapInstance || !mapInstance.getSource('nodes')) return;
    const features = state.nodes.map(node => ({
      type: 'Feature',
      properties: {
        code: node.code,
        name: node.name,
        country: node.country,
        layer: node.layer
      },
      geometry: {
        type: 'Point',
        coordinates: [node.lon, node.lat] // GeoJSON is [longitude, latitude]
      }
    }));
    mapInstance.getSource('nodes').setData({
      type: 'FeatureCollection',
      features: features
    });
  }

  function updateMapRoutes(mapInstance, paths) { // Renamed routesToDisplay to paths
    if (!mapInstance || !mapInstance.getSource('routes')) return;
    const features = paths.map((path, idx) => ({ // Changed route to path
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: path.nodes.map(nodeCode => { // Assuming path.nodes is array of nodeCodes
          const node = state.nodeMap.get(nodeCode); 
          return [node.lon, node.lat];
        })
      },
      properties: {
        id: `route-${idx}`, // Unique ID for filtering
        layer: path.layer // Assuming layer is available in path object from WASM
      }
    }));
    mapInstance.getSource('routes').setData({
      type: 'FeatureCollection',
      features: features
    });
  }

  function updateORSMapRoute(mapInstance, orsGeojson) {
    if (!mapInstance || !mapInstance.getSource('ors-route')) return;
    mapInstance.getSource('ors-route').setData({
      type: 'FeatureCollection',
      features: orsGeojson ? [{ type: 'Feature', geometry: orsGeojson }] : []
    });
  }

  function setInputField(field, value) {
    const val = (value || '').trim().toUpperCase();
    if (field === 'from') fromInput.value = val; else toInput.value = val;
    
    // Clear previous selection highlight
    if (state.selection.from) mainMapLibre.setFeatureState({source: 'nodes', id: state.selection.from.code}, {selected: false});
    if (state.selection.to) mainMapLibre.setFeatureState({source: 'nodes', id: state.selection.to.code}, {selected: false});

    const selectedNode = state.nodeMap.get(val);
    state.selection[field] = selectedNode || null;
    selectionFrom.textContent = state.selection.from?.code || '--';
    selectionTo.textContent = state.selection.to?.code || '--';

    // Apply new selection highlight
    if (selectedNode) {
      mainMapLibre.setFeatureState({source: 'nodes', id: selectedNode.code}, {selected: true});
      // Also update modal map if open
      if (mapModal.classList.contains('open') && modalMapLibre) {
         modalMapLibre.setFeatureState({source: 'nodes', id: selectedNode.code}, {selected: true});
      }
    }
  }

  // Changed from fetchAirports
  async function fetchNodes() {
    loader.textContent = '노드 데이터를 불러오는 중...';
    try {
      let data;
      // When WASM is ready, use the WASM kernel to get nodes data
      if (state.kernel && typeof state.kernel.getNodes === 'function') {
        data = JSON.parse(state.kernel.getNodes());
      } else if (state.nativeMode) {
        // Fallback to native server if WASM not available
        data = await fetchJsonOrError('./nodes?limit=8192'); // Assuming a /nodes endpoint
      } else {
        throw new Error(getWasmUnavailableMessage('노드 엔진이 준비되지 않았습니다.'));
      }

      const nodes = Array.isArray(data.nodes) ? data.nodes : [];
      state.nodes = nodes;
      state.nodeMap = new Map(state.nodes.map(n => [n.code, n]));
      statAirports.textContent = state.nodes.length.toLocaleString(); // Still using statAirports for total nodes

      updateMapNodes(mainMapLibre);
      if (mapModal.classList.contains('open')) {
        updateMapNodes(modalMapLibre);
      }
      
      loader.style.display = 'none';
    } catch (err) {
      loader.textContent = '데이터 로드 실패: ' + err.message;
      loader.classList.add('error');
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
    if (domesticTrackingPanel) domesticTrackingPanel.classList.toggle('hidden', mode !== 'domestic-tracking');
    
    // Trigger map resize when panel becomes visible
    if (mainMapLibre) mainMapLibre.resize();
    if (modalMapLibre && mapModal.classList.contains('open')) modalMapLibre.resize();
  }

  function setTrackingStatus(element, message, variant = 'info') {
    if (!element) return;
    element.textContent = message;
    element.classList.remove('error', 'success');
    if (variant === 'error') element.classList.add('error');
    if (variant === 'success') element.classList.add('success');
  }

  async function enableNativeMode() {
    try {
      const data = await fetchJsonOrError('./health');
      state.nativeMode = true;
      state.nativeHealth = data;
      state.wasmUnavailableReason = '';
      if (typeof data.nodes_loaded === 'number' && statAirports) { // Changed from airports_loaded
        statAirports.textContent = data.nodes_loaded.toLocaleString();
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
    const controls = [
      searchBtn,
      trackingAnalyzeBtnIntl,
      bestFromRefreshBtn,
      bestToRefreshBtn,
      trackingFetchBtnDomestic
    ];
    controls.forEach((btn) => {
      if (!btn) return;
      btn.disabled = true;
      btn.title = reason;
      btn.classList.add('disabled');
    });
    if (resultsEl) resultsEl.innerHTML = `<div class="empty-state">${reason}</div>`;
    if (bestFromResults) bestFromResults.innerHTML = `<div class="empty-state">${reason}</div>`;
    if (bestToResults) bestToResults.innerHTML = `<div class="empty-state">${reason}</div>`;
    if (trackingMetricsIntl) trackingMetricsIntl.innerHTML = `<div class="empty-state">${reason}</div>`;
    if (trackingStatusIntl) setTrackingStatus(trackingStatusIntl, reason, 'error');
    if (trackingMetricsDomestic) trackingMetricsDomestic.innerHTML = `<div class="empty-state">${reason}</div>`;
    if (trackingStatusDomestic) setTrackingStatus(trackingStatusDomestic, reason, 'error');
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
      // New: Check against MAJOR_LOGISTICS_CENTERS keywords
      const cleanedCandidate = candidate.toUpperCase();
      for (const center of MAJOR_LOGISTICS_CENTERS) {
        if (center.keywords.some(keyword => cleanedCandidate.includes(keyword.toUpperCase()))) {
          return center.alias;
        }
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

  // --- Domestic Tracking Functions ---

  // Modulus 7 implementation for domestic tracking numbers
  function verifyMod7Js(trackNo) {
      const len = trackNo.length;
      if (len < 10) return false;

      let mainPart = 0;
      const checkDigit = parseInt(trackNo[len - 1], 10);

      for (let i = 0; i < len - 1; i++) {
          mainPart = (mainPart * 10) + parseInt(trackNo[i], 10);
      }

      return (mainPart % 7) === checkDigit;
  }

  // Auto-detect domestic carriers based on tracking number patterns
  function resolveDomesticCarriers(trackNo) {
      const normalized = (trackNo || '').trim().replace(/[^0-9]/g, ''); // Remove non-digits
      const carriers = [];
      const pushUnique = (id, label) => {
          if (!carriers.some(entry => entry.id === id)) {
              carriers.push({ id, label });
          }
      };

      // Specific rules
      // 우체국택배 (13자리, 1,2,5,6으로 시작)
      if (normalized.length === 13 && (/^1\d{12}$/.test(normalized) || /^2\d{12}$/.test(normalized) || /^5\d{12}$/.test(normalized) || /^6\d{12}$/.test(normalized))) {
          pushUnique('kr.epost', '우체국택배');
          return carriers; // If matched, it's highly likely Epost, so return directly
      }
      // 로젠택배 (11자리, Mod 7)
      if (normalized.length === 11 && verifyMod7Js(normalized)) {
          pushUnique('kr.logen', '로젠택배');
          return carriers;
      }

      // Overlapping rules (Mod 7, 10 or 12 digits) - these will be candidates
      if ((normalized.length === 10 || normalized.length === 12) && verifyMod7Js(normalized)) {
          pushUnique('kr.cjlogistics', 'CJ대한통운');
          pushUnique('kr.hanjin', '한진택배');
      }
      
      // CU/GS25 (10 digits) - often uses CJ Logistics backend
      if (normalized.length === 10) {
          pushUnique('kr.cupost', 'CU 편의점택배');
          pushUnique('kr.cvsnet', 'GS25 편의점택배');
          pushUnique('kr.cjlogistics', 'CJ대한통운'); // Sometimes uses CJ backend
      }
      
      // Fallback for Mod 7 (if not caught by specific length rules and no other carriers added)
      if (verifyMod7Js(normalized) && carriers.length === 0) {
           pushUnique('kr.cjlogistics', 'CJ대한통운');
           pushUnique('kr.hanjin', '한진택배');
           pushUnique('kr.logen', '로젠택배');
      }

      // General 10-12 digit fallbacks if nothing specific found and no carriers yet
      if (carriers.length === 0) {
          if (normalized.length === 10 || normalized.length === 12) {
              pushUnique('kr.cjlogistics', 'CJ대한통운');
              pushUnique('kr.hanjin', '한진택배');
          }
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

      let lat = null;
      let lon = null;
      // Attempt to resolve lat/lon from state.nodeMap using the alias
      const resolvedNode = state.nodeMap.get(alias);
      if (resolvedNode) {
        lat = resolvedNode.lat;
        lon = resolvedNode.lon;
      }

      return {
        alias,
        countryCode,
        locationName: location ? (countryCode ? `${location} (${countryCode})` : location) : (countryCode || alias),
        statusText: progress?.status?.text || progress?.description || progress?.message || '',
        statusCode: progress?.status?.code || '',
        timestampToken: token,
        safetyStatus: progress?.safetyStatus || 'UNKNOWN', // Assuming safety status from API
        displayTime: formatTimelineTime(date),
        lat, // Added latitude
        lon, // Added longitude
        raw: progress
      };
    }).filter(Boolean);
  }

  async function fetchTrackingEventsIntl(invoice, candidateOverride) {
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

  function renderTrackingMetrics(metricsElement, result) {
    if (!metricsElement) return;
    if (!result || typeof result !== 'object') {
      metricsElement.innerHTML = '<div class="empty-state">분석 결과가 없습니다.</div>';
      return;
    }
    const formatPercent = (value) => (value * 100).toFixed(1) + '%';
    metricsElement.innerHTML = `
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

  function renderTrackingTimeline(timelineElement, events) {
    if (!timelineElement) return;
    if (!events.length) {
      timelineElement.innerHTML = '<div class="empty-state">우체국 이벤트를 불러오면 경로가 시간순으로 나타납니다.</div>';
      return;
    }
    timelineElement.innerHTML = events.map(evt => {
      const tags = [];
      if (evt.alias) tags.push(evt.alias);
      if (evt.countryCode && evt.countryCode !== evt.alias) tags.push(evt.countryCode);
      if (evt.safetyStatus && evt.safetyStatus !== 'UNKNOWN') tags.push(evt.safetyStatus);
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

  async function runTrackingAnalysisIntl(rawText) {
    if (!trackingLogInputIntl || !trackingStatusIntl) return;
    const payload = (rawText || '').trim();
    if (!payload) {
      setTrackingStatus(trackingStatusIntl, '분석할 이벤트 문자열이 없습니다.', 'error');
      return;
    }
    if (state.kernel && typeof state.kernel.analyzeTracking === 'function') {
      try {
        const result = JSON.parse(state.kernel.analyzeTracking(payload));
        renderTrackingMetrics(trackingMetricsIntl, result);
        setTrackingStatus(trackingStatusIntl, `분석 완료: EDI ${result.idiotScore?.toFixed ? result.idiotScore.toFixed(1) : '--'}`, 'success');
      } catch (err) {
        setTrackingStatus(trackingStatusIntl, '분석 실패: ' + err.message, 'error');
      }
      return;
    }
    if (state.nativeMode) {
      try {
        setTrackingStatus(trackingStatusIntl, '서버 분석 중...');
        const result = await analyzeTrackingNative(payload);
        renderTrackingMetrics(trackingMetricsIntl, result);
        setTrackingStatus(trackingStatusIntl, `분석 완료: EDI ${result.idiotScore?.toFixed ? result.idiotScore.toFixed(1) : '--'}`, 'success');
      } catch (err) {
        setTrackingStatus(trackingStatusIntl, '분석 실패: ' + err.message, 'error');
      }
      return;
    }
    setTrackingStatus(trackingStatusIntl, getWasmUnavailableMessage(), 'error');
  }

  async function handleTrackingFetchIntl() {
    if (!trackingNumberInputIntl) return;
    const invoice = trackingNumberInputIntl.value.trim();
    if (!invoice) {
      setTrackingStatus(trackingStatusIntl, '송장번호를 입력하세요.', 'error');
      trackingNumberInputIntl.focus();
      return;
    }
    const carriers = resolveKoreaPostCarriers(invoice);
    const carrierLabels = carriers.map(c => c.label).join(', ');
    setTrackingStatus(trackingStatusIntl, `한국 우체국 (${carrierLabels})에서 조회 중...`);
    try {
      const rawEvents = await fetchTrackingEventsIntl(invoice, carriers);
      const events = enrichTrackingEvents(rawEvents);
      state.trackingEventsIntl = events;
      if (!events.length) {
        setTrackingStatus(trackingStatusIntl, '파싱 가능한 공항 이벤트를 찾지 못했습니다. 로그를 직접 붙여넣어 주세요.', 'error');
        renderTrackingTimeline(trackingTimelineIntl, []);
        return;
      }
      renderTrackingTimeline(trackingTimelineIntl, events);
      const payload = buildTrackingPayload(events);
      if (trackingLogInputIntl) trackingLogInputIntl.value = payload;
      await runTrackingAnalysisIntl(payload);
    } catch (err) {
      setTrackingStatus(trackingStatusIntl, err.message || '조회 실패', 'error');
      renderTrackingTimeline(trackingTimelineIntl, []);
    }
  }

  // --- Domestic Tracking Fetch and Display ---

  async function fetchDomesticTrackingEvents(invoice, carrierId) {
      if (!carrierId) throw new Error('택배사 ID를 선택하거나 자동 감지해 주세요.');
      const endpoint = `${TRACKER_DELIVERY_API}/carriers/${carrierId}/tracks/${encodeURIComponent(invoice)}`;
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
          if (!progresses.length && !data.state) {
              throw new Error('진행 이벤트 또는 상태 정보가 비어 있습니다.');
          }
          return data;
      } catch (err) {
          throw new Error(`배송조회 API에 연결하지 못했습니다. ${err.message}`);
      }
  }

  async function handleDomesticTrackingFetch() {
      if (!trackingNumberInputDomestic) return;
      const invoice = trackingNumberInputDomestic.value.trim();
      if (!invoice) {
          setTrackingStatus(trackingStatusDomestic, '송장번호를 입력하세요.', 'error');
          trackingNumberInputDomestic.focus();
          return;
      }

      let selectedCarrierId = carrierSelectDomestic.value;

      if (!selectedCarrierId) {
          const detectedCarriers = resolveDomesticCarriers(invoice);
          if (detectedCarriers.length === 1) {
              selectedCarrierId = detectedCarriers[0].id;
              carrierSelectDomestic.value = selectedCarriers[0].id;
              setTrackingStatus(trackingStatusDomestic, `택배사 자동 감지: ${detectedCarriers[0].label}`, 'info');
          } else if (detectedCarriers.length > 1) {
              const carrierLabels = detectedCarriers.map(c => c.label).join(', ');
              setTrackingStatus(trackingStatusDomestic, `여러 택배사가 감지되었습니다 (${carrierLabels}). 직접 선택해 주세요.`, 'info');
              carrierSelectDomestic.value = '';
              return;
          } else {
              setTrackingStatus(trackingStatusDomestic, '택배사를 자동 감지할 수 없습니다. 직접 선택해 주세요.', 'error');
              return;
          }
      }

      setTrackingStatus(trackingStatusDomestic, `"${selectedCarrierId}"에서 조회 중...`);
      try {
          const data = await fetchDomesticTrackingEvents(invoice, selectedCarrierId);
          if (trackingLogInputDomestic) trackingLogInputDomestic.value = JSON.stringify(data, null, 2);

          const progresses = Array.isArray(data?.progresses) ? data.progresses : [];
          const enrichedEvents = enrichTrackingEvents(progresses);
          state.domesticTrackingEvents = enrichedEvents;

          if (!enrichedEvents.length) {
              if (data.state?.text) {
                  setTrackingStatus(trackingStatusDomestic, `조회 완료: ${data.state.text}`, 'success');
              } else {
                  setTrackingStatus(trackingStatusDomestic, '진행 이벤트를 찾지 못했습니다.', 'error');
              }
              renderTrackingTimeline(trackingTimelineDomestic, []);
              if (trackingMetricsDomestic) trackingMetricsDomestic.innerHTML = '<div class="empty-state">분석 결과가 없습니다.</div>';
              return;
          }

          renderTrackingTimeline(trackingTimelineDomestic, enrichedEvents);

          const fromName = data.from?.name || '알 수 없음';
          const toName = data.to?.name || '알 수 없음';
          const currentState = data.state?.text || '정보 없음';

          let orsDistanceHtml = '';
          const startEvent = enrichedEvents.find(e => e.lat != null && e.lon != null);
          const endEvent = enrichedEvents.reverse().find(e => e.lat != null && e.lon != null); // Find last valid event

          if (startEvent && endEvent && startEvent !== endEvent) {
            try {
                const orsRoute = await fetchORSPath(
                    { lat: startEvent.lat, lon: startEvent.lon },
                    { lat: endEvent.lat, lon: endEvent.lon }
                );
                if (orsRoute) {
                    updateORSMapRoute(mainMapLibre, orsRoute.geojson);
                    if (modalMapLibre) {
                        updateORSMapRoute(modalMapLibre, orsRoute.geojson);
                    }
                    orsDistanceHtml = `
                        <div class="metric">
                            <span>도로 최단거리</span>
                            <strong>${(orsRoute.distance / 1000).toFixed(1)} km</strong>
                        </div>
                    `;
                } else {
                    updateORSMapRoute(mainMapLibre, null); // Clear previous route
                    if (modalMapLibre) {
                        updateORSMapRoute(modalMapLibre, null);
                    }
                }
            } catch (orsErr) {
                console.warn('Failed to fetch ORS path for domestic tracking:', orsErr);
                orsDistanceHtml = `
                    <div class="metric">
                        <span>도로 최단거리</span>
                        <strong>조회 불가</strong>
                    </div>
                `;
            }
          } else {
            updateORSMapRoute(mainMapLibre, null); // Clear previous route
            if (modalMapLibre) {
                updateORSMapRoute(modalMapLibre, null);
            }
          }

          const metricsHtml = `
              <div class="metric">
                  <span>보내는 분</span>
                  <strong>${fromName}</strong>
              </div>
              <div class="metric">
                  <span>받는 분</span>
                  <strong>${toName}</strong>
              </div>
              <div class="metric">
                  <span>현재 상태</span>
                  <strong>${currentState}</strong>
              </div>
              ${orsDistanceHtml}
          `;
          if (trackingMetricsDomestic) trackingMetricsDomestic.innerHTML = metricsHtml;

          setTrackingStatus(trackingStatusDomestic, `조회 완료: ${currentState}`, 'success');

      } catch (err) {
          setTrackingStatus(trackingStatusDomestic, err.message || '조회 실패', 'error');
          renderTrackingTimeline(trackingTimelineDomestic, []);
          if (trackingMetricsDomestic) trackingMetricsDomestic.innerHTML = '<div class="empty-state">분석 결과가 없습니다.</div>';
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
          <h3>경로 ${i + 1}: ${p.nodes.map(n => n.code).join(' → ')}</h3>
          <p>${p.legs}구간 · ${p.totalDistanceKm.toFixed(1)}km · 효율 ${p.efficiency.toFixed(3)}</p>
        </div>
      `).join('') : '<div class="empty-state">경로 없음</div>';
      statusEl.textContent = `분석 완료: ${paths.length}개 발견`;
      updateMapRoutes(mainMapLibre, paths); // Replaced drawAllScenes()
    } catch (err) {
      statusEl.textContent = '오류: ' + err.message;
      resultsEl.innerHTML = `<div class="empty-state">${err.message}</div>`;
    }
  }

  // MapLibre click handler
  const handleMapClick = (e) => {
    const features = mainMapLibre.queryRenderedFeatures(e.point, { layers: [MapLayerStyle.NODE_CIRCLE.id] });
    if (features.length > 0) {
      const clickedNode = features[0].properties;
      setInputField(state.activeField, clickedNode.code);
    }
  };

  // Replace old canvas event listeners with MapLibre event listeners
  // These are currently empty, they will be added in the DOMContentLoaded block

  function openMapModal() {
    statusBeforeModal = statusEl.textContent;
    mapModal.classList.add('open'); mapModal.setAttribute('aria-hidden', 'false');
    if (modalMapLibre) {
      modalMapLibre.resize();
      // Sync map view from main map
      modalMapLibre.jumpTo({
        center: mainMapLibre.getCenter(),
        zoom: mainMapLibre.getZoom()
      });
      // Sync node states
      state.nodes.forEach(node => {
        const selected = (state.selection.from && state.selection.from.code === node.code) ||
                         (state.selection.to && state.selection.to.code === node.code);
        modalMapLibre.setFeatureState({source: 'nodes', id: node.code}, {selected: selected});
      });
      // Sync routes
      updateMapRoutes(modalMapLibre, state.routes);
    }
  }

  function closeMapModal() {
    mapModal.classList.remove('open'); mapModal.setAttribute('aria-hidden', 'true');
    statusEl.textContent = statusBeforeModal;
  }

  modalCloseBtn.addEventListener('click', closeMapModal);
  mapModal.addEventListener('click', (e) => { if (e.target === mapModal) closeMapModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mapModal.classList.contains('open')) closeMapModal(); });

  swapBtn.addEventListener('click', () => { const f = fromInput.value, t = toInput.value; setInputField('from', t); setInputField('to', f); });
  mapModeButtons.forEach(b => b.addEventListener('click', () => { mapModeButtons.forEach(x => x.classList.remove('active')); b.classList.add('active'); state.activeField = b.dataset.field; }));
  searchBtn.addEventListener('click', () => { searchRoutes().catch(err => console.error(err)); });
  modeTabs.forEach(tab => tab.addEventListener('click', () => setActivePanel(tab.dataset.modeTab || 'manual')));
  if (trackingFetchBtnIntl) trackingFetchBtnIntl.addEventListener('click', () => { handleTrackingFetchIntl().catch(err => console.error(err)); });
  if (trackingAnalyzeBtnIntl && trackingLogInputIntl) trackingAnalyzeBtnIntl.addEventListener('click', () => { runTrackingAnalysisIntl(trackingLogInputIntl.value).catch(err => console.error(err)); });
  if (trackingNumberInputIntl) {
    trackingNumberInputIntl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleTrackingFetchIntl();
      }
    });
  }

  if (trackingFetchBtnDomestic) trackingFetchBtnDomestic.addEventListener('click', () => { handleDomesticTrackingFetch().catch(err => console.error(err)); });
  if (trackingNumberInputDomestic) {
      trackingNumberInputDomestic.addEventListener('input', () => {
          setTrackingStatus(trackingStatusDomestic, '송장번호를 입력하세요.');
          const invoice = trackingNumberInputDomestic.value.trim();
          if (invoice.length >= 10) {
              const detected = resolveDomesticCarriers(invoice);
              if (detected.length === 1) {
                  carrierSelectDomestic.value = detected[0].id;
                  setTrackingStatus(trackingStatusDomestic, `택배사 자동 감지: ${detected[0].label}`, 'info');
              } else if (detected.length > 1) {
                  setTrackingStatus(trackingStatusDomestic, `여러 택배사가 감지되었습니다. 선택하거나 자동 감지를 기다리세요.`, 'info');
                  carrierSelectDomestic.value = '';
              } else {
                  carrierSelectDomestic.value = '';
                  setTrackingStatus(trackingStatusDomestic, '택배사를 자동 감지할 수 없습니다. 직접 선택해 주세요.', 'info');
              }
          } else {
              carrierSelectDomestic.value = '';
          }
      });
      trackingNumberInputDomestic.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
              e.preventDefault();
              handleDomesticTrackingFetch();
          }
      });
  }

  bestFromRefreshBtn.addEventListener('click', () => { requestBestFrom().catch(err => console.error(err)); });
  bestToRefreshBtn.addEventListener('click', () => { requestBestTo().catch(err => console.error(err)); });

  setActivePanel(state.uiMode || 'manual');
  window.addEventListener('resize', () => {
    if (mainMapLibre) mainMapLibre.resize();
    if (modalMapLibre) modalMapLibre.resize();
  });
  
  // Call init() last
  init();
});

async function init() {
  // Detect mobile device
  state.isMobile = detectMobile();
  
  // Removed setupTouchGestures();
  
  await initServiceWorker();
  const wasmReady = await initWasm();
  let nativeReady = false;
  if (!wasmReady) {
    nativeReady = await enableNativeMode();
    if (!nativeReady) {
      applyWasmDisabledUi();
    }
  }

  // Initialize MapLibre maps
  mainMapLibre = initMap('map-container');
  modalMapLibre = initMap('map-container-large', true);

  if (wasmReady) {
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
      state.bestWorker.postMessage({ type: 'compute_init', nodes: state.nodes }); // Pass nodes to worker
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
      statRoutes.textContent = h.routes_loaded.toLocaleString();
    }
  } else if (statRoutes) {
    statRoutes.textContent = '--';
  }
}

// Global functions that use state.nodes/nodeMap (renamed from airports/airportMap)

function getContinent(lat, lon) {
    // These values define approximate bounding boxes for continents.
    // They are not perfectly accurate and some regions may overlap or be excluded.
    // This function is for heuristic purposes in best-destination calculation only.
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
    const dest = state.nodeMap.get(rule.destination); // Renamed from airportMap
    if (dest && dest.country) countries.add(dest.country);
  }
  return countries;
}

async function computeBestDestinationsLocal(originCode, continentFilter) {
  if (!state.kernel || state.nodes.length === 0) return {}; // Renamed from airports
  const origin = state.nodeMap.get(originCode); // Renamed from airportMap
  if (!origin) return {};
  const filterContinent = continentFilter || getContinent(origin.lat, origin.lon);
  const originCountry = origin.country || '';
  const forbiddenCountries = getForbiddenCountries(originCode);

  // --- Tier 1: Spatial filtering (500km / 1000km bounding box) ---
  const tier1Near = [];
  const tier1Far = [];
  for (const n of state.nodes) { // Renamed from airports
    if (n.code === originCode) continue;
    if (getContinent(n.lat, n.lon) !== filterContinent) continue;
    // Skip domestic (same-country) destinations
    if (originCountry && n.country && n.country === originCountry) continue;
    // Skip destinations in forbidden countries
    if (n.country && forbiddenCountries.has(n.country)) continue;
    const dist = haversineKm(origin.lat, origin.lon, n.lat, n.lon);
    if (dist <= 500) tier1Near.push(n);
    else if (dist <= 1000) tier1Far.push(n);
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
        const existing = state.nodeMap.get(d.code); // Renamed from airportMap
        const destCountry = d.country || existing?.country || '';
        if (originCountry && destCountry && destCountry === originCountry) continue;
        // Skip destinations in forbidden countries
        if (destCountry && forbiddenCountries.has(destCountry)) continue;
        if (d.connections >= HUB_MIN_CONNECTIONS) {
          if (existing) tier2Hubs.push(existing);
          else tier2Hubs.push({ code: d.code, lat: d.lat, lon: d.lon, country: destCountry });
        }
      }
    } catch { /* skip */ }
  }

  // --- Merge and deduplicate ---
  const seen = new Set();
  const candidates = [];
  for (const list of [tier1Near, tier2Hubs, tier1Far]) {
    for (const n of list) { // Renamed from airports
      if (!seen.has(n.code)) {
        seen.add(n.code);
        candidates.push(n);
      }
    }
  }

  if (candidates.length < 20) {
    const remaining = state.nodes.filter(n => { // Renamed from airports
      if (n.code === originCode || seen.has(n.code)) return false;
      if (originCountry && n.country && n.country === originCountry) return false;
      if (n.country && forbiddenCountries.has(n.country)) return false;
      return getContinent(n.lat, n.lon) === filterContinent;
    });
    for (const n of remaining) { // Renamed from airports
      if (!seen.has(n.code)) {
        seen.add(n.code);
        candidates.push(n);
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
        hops: path.nodes ? path.nodes.length - 1 : 0, // Renamed from airports
        route: path.nodes ? path.nodes.map(n => n.code).join(' → ') : originCode + ' → ' + dest.code // Renamed
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
  if (!state.nativeMode || state.nodes.length === 0) return {}; // Renamed from airports
  const origin = state.nodeMap.get(originCode); // Renamed from airportMap
  if (!origin) return {};
  const filterContinent = continentFilter || getContinent(origin.lat, origin.lon);
  const originCountry = origin.country || '';
  const forbiddenCountries = getForbiddenCountries(originCode);

  const tier1Near = [];
  const tier1Far = [];
  for (const n of state.nodes) { // Renamed from airports
    if (n.code === originCode) continue;
    if (getContinent(n.lat, n.lon) !== filterContinent) continue;
    if (originCountry && n.country && n.country === originCountry) continue;
    if (n.country && forbiddenCountries.has(n.country)) continue;
    const dist = haversineKm(origin.lat, origin.lon, n.lat, n.lon);
    if (dist <= 500) tier1Near.push(n);
    else if (dist <= 1000) tier1Far.push(n);
  }

  const tier2Hubs = [];
  if (state.kernel.getDirectDests) {
    try {
      const directData = JSON.parse(state.kernel.getDirectDests(originCode));
      const directDests = directData.destinations || [];
      const HUB_MIN_CONNECTIONS = 30;
      for (const d of directDests) {
        if (getContinent(d.lat, d.lon) !== filterContinent) continue;
        const existing = state.nodeMap.get(d.code); // Renamed from airportMap
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
  }

  const seen = new Set();
  const candidates = [];
  for (const list of [tier1Near, tier2Hubs, tier1Far]) {
    for (const n of list) { // Renamed from airports
      if (!seen.has(n.code)) {
        seen.add(n.code);
        candidates.push(n);
      }
    }
  }

  if (candidates.length < 20) {
    const remaining = state.nodes.filter(n => { // Renamed from airports
      if (n.code === originCode || seen.has(n.code)) return false;
      if (originCountry && n.country && n.country === originCountry) return false;
      if (n.country && forbiddenCountries.has(n.country)) return false;
      return getContinent(n.lat, n.lon) === filterContinent;
    });
    for (const n of remaining) { // Renamed from airports
      if (!seen.has(n.code)) {
        seen.add(n.code);
        candidates.push(n);
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
        hops: path.nodes ? path.nodes.length - 1 : 0, // Renamed from airports
        route: path.nodes ? path.nodes.map(n => n.code).join(' → ') : originCode + ' → ' + dest.code // Renamed
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
  if (fromCode.length !== 3 || !state.nodeMap.has(fromCode)) {
    bestFromResults.innerHTML = '<div class="empty-state">유효한 3자리 IATA 코드를 입력하세요.</div>';
    return;
  }
  const continent = bestFromContinentSelect ? bestFromContinentSelect.value : '';
  const origin = state.nodeMap.get(fromCode);
  const label = continent || (origin ? getContinent(origin.lat, origin.lon) : '');
  bestFromTitle.textContent = fromCode + '에서 최적 목적지' + (label ? ' (' + label + ')' : '');
  bestFromResults.classList.add('loading');
  bestFromResults.innerHTML = '<div class="empty-state">계산 중...</div>';
  if (state.bestWorker) {
    const nodes = state.nodes.map(n => ({ code: n.code, lat: n.lat, lon: n.lon, country: n.country || '', layer: n.layer }));
    state.bestRequestId++;
    state.bestWorker.postMessage({ type: 'compute', id: state.bestRequestId, originCode: fromCode, nodes, continent });
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
  if (toCode.length !== 3 || !state.nodeMap.has(toCode)) {
    bestToResults.innerHTML = '<div class="empty-state">유효한 3자리 IATA 코드를 입력하세요.</div>';
    return;
  }
  const continent = bestToContinentSelect ? bestToContinentSelect.value : '';
  const origin = state.nodeMap.get(toCode);
  const label = continent || (origin ? getContinent(origin.lat, origin.lon) : '');
  bestToTitle.textContent = toCode + '에서 최적 목적지' + (label ? ' (' + label + ')' : '');
  bestToResults.classList.add('loading');
  bestToResults.innerHTML = '<div class="empty-state">계산 중...</div>';
  if (state.bestWorker) {
    const nodes = state.nodes.map(n => ({ code: n.code, lat: n.lat, lon: n.lon, country: n.country || '', layer: n.layer }));
    state.bestRequestId++;
    state.bestWorker.postMessage({ type: 'compute', id: state.bestRequestId, originCode: toCode, nodes, continent });
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
  
  await initServiceWorker();
  const wasmReady = await initWasm();
  let nativeReady = false;
  if (!wasmReady) {
    nativeReady = await enableNativeMode();
    if (!nativeReady) {
      applyWasmDisabledUi();
    }
  }

  // Initialize MapLibre maps
  mainMapLibre = initMap('map-container');
  modalMapLibre = initMap('map-container-large', true);

  if (wasmReady) {
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
      state.bestWorker.postMessage({ type: 'compute_init', nodes: state.nodes }); // Pass nodes to worker
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
      statRoutes.textContent = h.routes_loaded.toLocaleString();
    }
  } else if (statRoutes) {
    statRoutes.textContent = '--';
  }
}
