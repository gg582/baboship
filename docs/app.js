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
  uiMode: 'tracking',
  trackingEventsIntl: [],
  trackingEtaIntl: null,
  wasmUnavailableReason: '',
  nativeMode: false,
  nativeHealth: null,
  nativeDirectCache: new Map(),
  trackingRouteHintIntl: null
};

// Global MapLibre map objects
let mainMapLibre = null;
let modalMapLibre = null;
const MOBILE_BREAKPOINT_WIDTH = 768;

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

const TRANSPORT_SPEED_KMH = {
  air: 780,
  sea: 36,
  land: 65
};

const MODE_LABELS = {
  air: '항공',
  sea: '선박',
  land: '내륙'
};

const DEFAULT_DESTINATION_ISO = 'KR';

const COUNTRY_HUBS = {
  AE: { code: 'DXB', mode: 'air' },
  AU: { code: 'SYD', mode: 'air' },
  BR: { code: 'GRU', mode: 'air' },
  CA: { code: 'YYZ', mode: 'air' },
  CL: { code: 'SCL', mode: 'air' },
  CN: { code: 'PVG', mode: 'air' },
  DE: { code: 'FRA', mode: 'air' },
  ES: { code: 'MAD', mode: 'air' },
  FI: { code: 'HEL', mode: 'air' },
  FR: { code: 'CDG', mode: 'air' },
  GB: { code: 'LHR', mode: 'air' },
  HK: { code: 'HKG', mode: 'air' },
  IN: { code: 'DEL', mode: 'air' },
  IT: { code: 'FCO', mode: 'air' },
  JP: { code: 'NRT', mode: 'air' },
  KR: { code: 'ICN', mode: 'air' },
  MX: { code: 'MEX', mode: 'air' },
  MY: { code: 'KUL', mode: 'air' },
  NL: { code: 'AMS', mode: 'air' },
  PH: { code: 'MNL', mode: 'air' },
  QA: { code: 'DOH', mode: 'air' },
  RU: { code: 'SVO', mode: 'air' },
  SA: { code: 'RUH', mode: 'air' },
  SE: { code: 'ARN', mode: 'air' },
  SG: { code: 'SIN', mode: 'air' },
  TH: { code: 'BKK', mode: 'air' },
  TR: { code: 'IST', mode: 'air' },
  US: { code: 'JFK', mode: 'air' },
  VN: { code: 'SGN', mode: 'air' },
  ZA: { code: 'JNB', mode: 'air' }
};

const HARD_CODED_NODE_FALLBACKS = {
  ICN: { code: 'ICN', lat: 37.4692, lon: 126.4505, layer: 'air' },
  JFK: { code: 'JFK', lat: 40.6413, lon: -73.7781, layer: 'air' },
  PVG: { code: 'PVG', lat: 31.1443, lon: 121.8083, layer: 'air' },
  FRA: { code: 'FRA', lat: 50.0379, lon: 8.5622, layer: 'air' },
  LHR: { code: 'LHR', lat: 51.4700, lon: -0.4543, layer: 'air' }
};

const MALFORMED_JSON_REPAIR_MODULE_URL = 'https://cdn.jsdelivr.net/npm/jsonrepair@3.11.0/+esm';
const CALENDAR_LIB_MODULE_URL = 'https://cdn.jsdelivr.net/npm/dayjs@1.11.13/+esm';
let jsonRepairFunction = null;
let jsonRepairImportPromise = null;
let dayjsFunction = null;
let dayjsImportPromise = null;
const TOP_ROUTE_MAX_TRANSFERS = 5;
const TOP_ROUTE_CANDIDATE_LIMIT = 24;
const TOP_ROUTE_TAKE = 5;

const SEA_KEYWORDS = [/PORT/i, /TERMINAL/i, /WHARF/i, /부두/, /항\b/, /碼頭/];
const LAND_KEYWORDS = [/허브/, /센터/, /물류/, /소포/, /delivery/i, /hub/i];
const DELIVERED_PATTERNS = [/배달완료/, /배송완료/, /수취완료/, /delivered/i];
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

async function parseJsonWithRecovery(raw, context = 'JSON') {
  const normalized = typeof raw === 'string' ? raw.replace(/^\uFEFF/, '').trim() : '';
  try {
    return JSON.parse(normalized);
  } catch (parseErr) {
    if (!jsonRepairImportPromise) {
      jsonRepairImportPromise = import(MALFORMED_JSON_REPAIR_MODULE_URL);
    }
    if (!jsonRepairFunction) {
      try {
        const mod = await jsonRepairImportPromise;
        if (typeof mod.jsonrepair === 'function') {
          jsonRepairFunction = mod.jsonrepair;
        } else if (typeof mod.jsonRepair === 'function') {
          jsonRepairFunction = mod.jsonRepair;
        } else if (typeof mod.default === 'function') {
          jsonRepairFunction = mod.default;
        } else {
          console.warn('Malformed JSON recovery library has no supported export shape.');
        }
      } catch (loadErr) {
        console.warn('Malformed JSON recovery library load failed:', loadErr);
      }
    }
    if (typeof jsonRepairFunction === 'function') {
      try {
        return JSON.parse(jsonRepairFunction(normalized));
      } catch (repairErr) {
        console.warn(`${context} recovery failed:`, repairErr);
      }
    }
    throw parseErr;
  }
}

async function loadDayjsFunction() {
  if (dayjsFunction) return dayjsFunction;
  if (!dayjsImportPromise) {
    dayjsImportPromise = import(CALENDAR_LIB_MODULE_URL)
      .then((mod) => {
        if (typeof mod?.default === 'function') {
          dayjsFunction = mod.default;
          return dayjsFunction;
        }
        throw new Error('dayjs default export is unavailable');
      })
      .catch((err) => {
        console.warn('dayjs 로드 실패, 기본 날짜 포맷으로 대체:', err);
        dayjsImportPromise = null;
        return null;
      });
  }
  return dayjsImportPromise;
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
  return window.innerWidth <= MOBILE_BREAKPOINT_WIDTH;
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
    const kernelArgs = {
      locateFile: (path) => resolveAsset(`wasm/${path}`)
    };
    // The pre-built binary may have been compiled with pthreads support, which
    // requires SharedArrayBuffer (needs COOP/COEP headers not set on GitHub Pages).
    // Since the C worker pool is disabled, we can safely use non-shared memory
    // to make the module work in all environments.
    if (typeof SharedArrayBuffer === 'undefined') {
      kernelArgs.wasmMemory = new WebAssembly.Memory({ initial: 512, maximum: 32768 });
    }
    state.kernel = await createNukeKernel(kernelArgs);
    
    if (!state.kernel.cwrap) {
      console.error('WASM Kernel loaded but cwrap is missing. Check EXPORTED_RUNTIME_METHODS.');
      throw new Error('cwrap missing');
    }

    // Bind WASM functions via cwrap (wraps C-exported symbols).
    // Support both new (get_nodes_json) and old (get_airports_json) binary names.
    state.kernel.initStore = state.kernel.cwrap('nuke_wasm_init', 'number', []);
    state.kernel.loadData = state.kernel.cwrap('nuke_wasm_load_data', 'number', ['number', 'number']);
    if (state.kernel['_nuke_wasm_get_nodes_json']) {
      state.kernel.getNodes = state.kernel.cwrap('nuke_wasm_get_nodes_json', 'string', []);
    } else {
      // Fallback for older binary compiled before rename
      state.kernel.getNodes = state.kernel.cwrap('nuke_wasm_get_airports_json', 'string', []);
    }
    state.kernel.getBest = state.kernel.cwrap('nuke_wasm_get_best_nodes_json', 'string', []);
    state.kernel.getHealth = state.kernel.cwrap('nuke_wasm_get_health_json', 'string', []);
    state.kernel.searchRoutes = state.kernel.cwrap('nuke_wasm_search_routes_json', 'string', ['string', 'string', 'number']);
    state.kernel.calcScore = state.kernel.cwrap('nuke_wasm_calc_score', 'number', ['number', 'number', 'number', 'number', 'number']);
    if (state.kernel['_nuke_wasm_get_direct_destinations_json']) {
      state.kernel.getDirectDests = state.kernel.cwrap('nuke_wasm_get_direct_destinations_json', 'string', ['string']);
    }
    if (state.kernel['_analyze_tracking']) {
      state.kernel.analyzeTracking = state.kernel.cwrap('analyze_tracking', 'string', ['string']);
    }

    if (typeof state.kernel.initStore !== 'function') {
      if (typeof state.kernel._nuke_wasm_init === 'function') {
        state.kernel.initStore = state.kernel._nuke_wasm_init;
      } else {
        throw new Error('initStore is not a function - symbol might be missing in WASM exports');
      }
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
  const trackingNumberInputIntl = document.getElementById('tracking-number-intl') || document.getElementById('tracking-number');
  const trackingFetchBtnIntl = document.getElementById('tracking-fetch-btn-intl') || document.getElementById('tracking-fetch-btn');
  const trackingLogInputIntl = document.getElementById('tracking-log-input-intl') || document.getElementById('tracking-log-input');
  const trackingAnalyzeBtnIntl = document.getElementById('tracking-analyze-btn-intl') || document.getElementById('tracking-analyze-btn');
  const trackingStatusIntl = document.getElementById('tracking-status-intl') || document.getElementById('tracking-status');
  const trackingMetricsIntl = document.getElementById('tracking-metrics-intl') || document.getElementById('tracking-metrics');
  const trackingTimelineIntl = document.getElementById('tracking-timeline-intl') || document.getElementById('tracking-timeline');
  const trackingMetricsDomestic = document.getElementById('tracking-metrics-domestic');
  const trackingStatusDomestic = document.getElementById('tracking-status-domestic');
  const trackingFetchBtnDomestic = document.getElementById('tracking-fetch-btn-domestic');
  const maritimePanel = document.getElementById('maritime-panel');

  // --- MapLibre GL JS Integration ---
  function initMap(containerId, isModal = false) {
    const map = new maplibregl.Map({
      container: containerId,
      dragPan: true,
      scrollZoom: !state.isMobile,
      touchZoomRotate: state.isMobile,
      dragRotate: !state.isMobile,
      keyboard: !state.isMobile,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors'
          }
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
      },
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
        try {
          data = await parseJsonWithRecovery(state.kernel.getNodes(), 'WASM nodes JSON');
        } catch (err) {
          console.warn('WASM nodes JSON parse failed, falling back to airports.json:', err);
          data = { nodes: await fetchJsonOrError('./airports.json') };
        }
      } else if (state.nativeMode) {
        // Fallback to native server if WASM not available
        data = await fetchJsonOrError('./nodes?limit=8192'); // Assuming a /nodes endpoint
      } else {
        throw new Error(getWasmUnavailableMessage('노드 엔진이 준비되지 않았습니다.'));
      }

      const nodes = Array.isArray(data.nodes) ? data.nodes
                   : Array.isArray(data.airports) ? data.airports : [];
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
    if (maritimePanel) maritimePanel.classList.toggle('hidden', mode !== 'maritime');
    
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

  function getHubNode(code, iso, preferredLayer) {
    if (!code) return null;
    const normalizedIso = (iso || DEFAULT_DESTINATION_ISO).trim().toUpperCase() || DEFAULT_DESTINATION_ISO;
    const node = state.nodeMap.get(code);
    if (node) {
      return {
        code: node.code,
        lat: node.lat,
        lon: node.lon,
        layer: node.layer || preferredLayer || 'air',
        iso: normalizedIso
      };
    }
    if (HARD_CODED_NODE_FALLBACKS[code]) {
      const fallback = HARD_CODED_NODE_FALLBACKS[code];
      return {
        code: fallback.code,
        lat: fallback.lat,
        lon: fallback.lon,
        layer: fallback.layer || preferredLayer || 'air',
        iso: normalizedIso
      };
    }
    return null;
  }

  function resolveCountryHubNode(iso) {
    const normalized = (iso || DEFAULT_DESTINATION_ISO).trim().toUpperCase() || DEFAULT_DESTINATION_ISO;
    const hub = COUNTRY_HUBS[normalized] || COUNTRY_HUBS[DEFAULT_DESTINATION_ISO];
    if (!hub) return null;
    return getHubNode(hub.code, normalized, hub.mode);
  }

  function inferLayerFromAlias(alias, locationName) {
    const combined = `${alias || ''} ${locationName || ''}`.toUpperCase();
    if (SEA_KEYWORDS.some((pattern) => pattern.test(combined))) {
      return 'sea';
    }
    if (LAND_KEYWORDS.some((pattern) => pattern.test(combined))) {
      return 'land';
    }
    return 'air';
  }

  function isDeliveredEvent(evt) {
    if (!evt) return false;
    const text = (evt.statusText || '').toLowerCase();
    if (DELIVERED_PATTERNS.some((pattern) => pattern.test(text))) return true;
    const code = (evt.statusCode || '').toLowerCase();
    return code === 'delivered' || code === 'complete';
  }

  function hasSeaHint(evt) {
    if (!evt) return false;
    const text = `${evt.alias || ''} ${evt.locationName || ''} ${evt.statusText || ''}`.toUpperCase();
    return SEA_KEYWORDS.some((pattern) => pattern.test(text));
  }

  function determineFutureMode(lastEvent, destination, events) {
    if (!lastEvent || !destination) return 'air';
    if (lastEvent.layer === 'sea' || destination.layer === 'sea' || hasSeaHint(lastEvent)) {
      return 'sea';
    }
    const lastIso = (lastEvent.countryCode || '').toUpperCase();
    if (destination.iso && destination.iso === lastIso) {
      return 'land';
    }
    if (events && events.some((evt) => evt.layer === 'sea')) {
      return 'sea';
    }
    if (lastEvent.layer === 'land') return 'land';
    return 'air';
  }

  function computePendingProcessingHours(evt) {
    if (!evt) return 0;
    const text = (evt.statusText || '').toLowerCase();
    let hours = 0;
    if (/교환국/.test(text)) {
      if (/도착|접수/.test(text) && !/완료|통과/.test(text)) {
        hours += 18;
      } else {
        hours += 8;
      }
    }
    if (/통관/.test(text)) {
      hours += /완료/.test(text) ? 4 : 14;
    }
    if (/배달준비|배송준비|집배준비/.test(text)) {
      hours += 6;
    }
    if (/배달중/.test(text)) {
      hours += 3;
    }
    return hours;
  }

  function determineLastMileHours(targetIso, lastIso) {
    const normalizedTarget = (targetIso || DEFAULT_DESTINATION_ISO).toUpperCase();
    const normalizedLast = (lastIso || '').toUpperCase();
    if (normalizedTarget === 'KR' && normalizedLast === 'KR') {
      return 8;
    }
    if (normalizedTarget && normalizedTarget === normalizedLast) {
      return 6;
    }
    return 12;
  }

  function computeEtaConfidence(eventCount, remainingDistance) {
    if (eventCount >= 5 && remainingDistance < 500) return '높음';
    if (eventCount >= 3 && remainingDistance < 3500) return '중간';
    return '낮음';
  }

  function buildEtaReason(detail) {
    const parts = [];
    if (detail.remainingDistance && detail.remainingDistance > 5) {
      const rounded = Math.round(detail.remainingDistance);
      const kmLabel = `${rounded.toLocaleString()} km`;
      parts.push(`남은거리 ${kmLabel} (${MODE_LABELS[detail.mode] || detail.mode})`);
    }
    if (detail.processingHours) {
      parts.push(`교환국/통관 ${Math.round(detail.processingHours)}시간`);
    }
    if (detail.lastMileHours) {
      parts.push(`라스트마일 ${Math.round(detail.lastMileHours)}시간`);
    }
    if (detail.routeDistanceMinKm && detail.routeDistanceMaxKm) {
      parts.push(`Top-5 항공거리 ${Math.round(detail.routeDistanceMinKm).toLocaleString()}~${Math.round(detail.routeDistanceMaxKm).toLocaleString()} km`);
    }
    if (detail.currentPositionText) {
      parts.push(detail.currentPositionText);
    }
    if (detail.remainingRangeMinKm && detail.remainingRangeMaxKm) {
      parts.push(`남은거리 ${Math.round(detail.remainingRangeMinKm).toLocaleString()}~${Math.round(detail.remainingRangeMaxKm).toLocaleString()} km`);
    }
    return parts.join(' · ') || '휴리스틱 추정치';
  }

  function extractRouteAlias(candidate, fallbackIso = '') {
    if (!candidate) return '';
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim().toUpperCase();
      if (trimmed.length === 3 && state.nodeMap.has(trimmed)) return trimmed;
      return normalizeTrackingLocation(trimmed, trimmed, fallbackIso);
    }
    const code = (candidate.code || candidate.id || candidate.iata || '').toString().trim().toUpperCase();
    if (code.length === 3 && state.nodeMap.has(code)) return code;
    const name = (candidate.name || candidate.location || candidate.display || '').toString().trim();
    const iso = (candidate.countryCode || candidate.country || fallbackIso || '').toString().trim().toUpperCase();
    const alias = normalizeTrackingLocation(name, code, iso);
    return (alias.length === 3 && state.nodeMap.has(alias)) ? alias : '';
  }

  function resolveTrackingRouteHint(trackingData, events) {
    const route = trackingData?.route || trackingData?.summary?.route || {};
    const originCandidate = trackingData?.from || trackingData?.origin || route?.from || route?.origin || trackingData?.sender;
    const destinationCandidate = trackingData?.to || trackingData?.destination || route?.to || route?.destination || trackingData?.receiver;

    let originCode = extractRouteAlias(originCandidate);
    let destinationCode = extractRouteAlias(destinationCandidate);
    if (!originCode && Array.isArray(events) && events.length) {
      originCode = extractRouteAlias(events[0]?.alias, events[0]?.countryCode);
    }
    if (!destinationCode && Array.isArray(events) && events.length) {
      const lastEvent = events[events.length - 1];
      destinationCode = extractRouteAlias(lastEvent?.alias, lastEvent?.countryCode);
    }
    if (!originCode || !destinationCode || originCode === destinationCode) return null;
    return { originCode, destinationCode };
  }

  function computeObservedDistanceKm(events) {
    if (!Array.isArray(events) || events.length < 2) return 0;
    let sum = 0;
    for (let i = 1; i < events.length; i += 1) {
      const prev = events[i - 1];
      const curr = events[i];
      if (
        Number.isFinite(prev?.lat) &&
        Number.isFinite(prev?.lon) &&
        Number.isFinite(curr?.lat) &&
        Number.isFinite(curr?.lon)
      ) {
        sum += haversineKm(prev.lat, prev.lon, curr.lat, curr.lon);
      }
    }
    return Number.isFinite(sum) ? sum : 0;
  }

  async function formatEtaDateRangeText(startTimestamp, endTimestamp) {
    if (!Number.isFinite(startTimestamp)) return '';
    const safeEnd = Number.isFinite(endTimestamp) ? endTimestamp : startTimestamp;
    const formatNative = (timestamp) => {
      const date = new Date(timestamp);
      return `${date.getMonth() + 1}월${date.getDate()}일`;
    };
    const dayjs = await loadDayjsFunction();
    if (typeof dayjs !== 'function') {
      return `${formatNative(startTimestamp)}-${formatNative(safeEnd)} 내`;
    }
    const from = dayjs(startTimestamp);
    const to = dayjs(safeEnd);
    if (!from.isValid() || !to.isValid()) {
      return `${formatNative(startTimestamp)}-${formatNative(safeEnd)} 내`;
    }
    return `${from.format('M월D일')}-${to.format('M월D일')} 내`;
  }

  function resolveDestinationHub(events, lastEvent) {
    const isoCounts = new Map();
    for (const evt of events || []) {
      const iso = (evt.countryCode || '').trim().toUpperCase();
      if (iso) {
        isoCounts.set(iso, (isoCounts.get(iso) || 0) + 1);
      }
    }
    const hasKorea = isoCounts.has('KR');
    const hasForeign = Array.from(isoCounts.keys()).some((code) => code !== 'KR');
    let targetIso = '';
    if (hasKorea && hasForeign) {
      targetIso = 'KR';
    } else if (lastEvent && lastEvent.countryCode) {
      targetIso = lastEvent.countryCode.toUpperCase();
    } else if (isoCounts.size) {
      const [candidate] = [...isoCounts.entries()].sort((a, b) => b[1] - a[1]);
      targetIso = candidate ? candidate[0] : '';
    }
    if (!targetIso) targetIso = DEFAULT_DESTINATION_ISO;
    const destination = resolveCountryHubNode(targetIso);
    if (destination) return destination;
    if (targetIso !== DEFAULT_DESTINATION_ISO) {
      return resolveCountryHubNode(DEFAULT_DESTINATION_ISO);
    }
    return null;
  }

  async function estimateDeliveryEta(events, routeHint = null) {
    if (!Array.isArray(events) || events.length === 0) return null;
    if (events.some((evt) => isDeliveredEvent(evt))) {
      return { delivered: true };
    }
    const enrichable = events.filter((evt) => (
      typeof evt.timestampMs === 'number' &&
      typeof evt.lat === 'number' &&
      typeof evt.lon === 'number' &&
      Number.isFinite(evt.timestampMs) &&
      Number.isFinite(evt.lat) &&
      Number.isFinite(evt.lon)
    ));
    if (!enrichable.length) return null;
    const sorted = enrichable.slice().sort((a, b) => a.timestampMs - b.timestampMs);
    const lastEvent = sorted[sorted.length - 1];
    const destination = resolveDestinationHub(events, lastEvent);
    if (!destination || typeof lastEvent.timestampMs !== 'number') return null;
    let remainingDistance = 0;
    if (typeof lastEvent.lat === 'number' && typeof lastEvent.lon === 'number') {
      remainingDistance = haversineKm(lastEvent.lat, lastEvent.lon, destination.lat, destination.lon);
    }
    if (!Number.isFinite(remainingDistance)) remainingDistance = 0;
    const futureMode = determineFutureMode(lastEvent, destination, events);
    const speed = TRANSPORT_SPEED_KMH[futureMode] || TRANSPORT_SPEED_KMH.air;
    const remainingTravelHours = remainingDistance > 5 ? (remainingDistance / speed) : 0;
    const processingHours = computePendingProcessingHours(lastEvent);
    const lastMileHours = determineLastMileHours(destination.iso, lastEvent.countryCode);
    const etaHours = remainingTravelHours + processingHours + lastMileHours;
    if (!Number.isFinite(etaHours)) return null;
    let etaTimestamp = lastEvent.timestampMs + (etaHours * 3600 * 1000);
    let etaRangeDisplay = '';
    let routeDistanceMinKm = 0;
    let routeDistanceMaxKm = 0;
    const observedDistanceBase = computeObservedDistanceKm(sorted);
    let remainingRangeMinKm = remainingDistance;
    let remainingRangeMaxKm = remainingDistance;
    const totalProjectedBaseKm = observedDistanceBase + remainingDistance;
    const baseProgressRatio = totalProjectedBaseKm > 0 ? clampNumber(observedDistanceBase / totalProjectedBaseKm, 0, 1) : 0;
    let currentPositionText = `현재 예상 위치 약 ${Math.round(baseProgressRatio * 100)}% 지점`;
    if (routeHint?.originCode && routeHint?.destinationCode && (state.kernel || state.nativeMode)) {
      try {
        const routeData = await runRouteSearch(
          routeHint.originCode,
          routeHint.destinationCode,
          TOP_ROUTE_MAX_TRANSFERS,
          TOP_ROUTE_CANDIDATE_LIMIT
        );
        const paths = Array.isArray(routeData?.paths) ? routeData.paths : [];
        const topCandidates = paths
          .filter((path) => Number.isFinite(path?.totalDistanceKm) && path.totalDistanceKm > 0)
          .sort((a, b) => a.totalDistanceKm - b.totalDistanceKm)
          .slice(0, TOP_ROUTE_TAKE);
        if (topCandidates.length) {
          const observedDistance = observedDistanceBase;
          routeDistanceMinKm = topCandidates[0].totalDistanceKm;
          routeDistanceMaxKm = topCandidates[topCandidates.length - 1].totalDistanceKm;
          const etaHoursByCandidate = topCandidates.map((candidate) => {
            const remainingKm = Math.max(candidate.totalDistanceKm - observedDistance, 0);
            const travelHours = remainingKm > 5 ? (remainingKm / speed) : 0;
            return travelHours + processingHours + lastMileHours;
          });
          const minHours = Math.min(...etaHoursByCandidate);
          const maxHours = Math.max(...etaHoursByCandidate);
          const minTimestamp = lastEvent.timestampMs + (minHours * 3600 * 1000);
          const maxTimestamp = lastEvent.timestampMs + (maxHours * 3600 * 1000);
          etaTimestamp = minTimestamp;
          remainingRangeMinKm = Math.max(routeDistanceMinKm - observedDistance, 0);
          remainingRangeMaxKm = Math.max(routeDistanceMaxKm - observedDistance, 0);
          const projectedTotalKm = observedDistance + remainingRangeMaxKm;
          const progressRatio = projectedTotalKm > 0 ? clampNumber(observedDistance / projectedTotalKm, 0, 1) : 0;
          currentPositionText = `현재 예상 위치 약 ${Math.round(progressRatio * 100)}% 지점`;
          etaRangeDisplay = await formatEtaDateRangeText(minTimestamp, maxTimestamp);
        }
      } catch (err) {
        console.warn('Failed to build Top5 route ETA range:', err);
      }
    }
    if (!etaRangeDisplay) {
      etaRangeDisplay = await formatEtaDateRangeText(etaTimestamp, etaTimestamp);
    }
    return {
      delivered: false,
      etaTimestamp,
      etaDisplay: formatTimelineTime(new Date(etaTimestamp)),
      etaRangeDisplay,
      observedKm: observedDistanceBase,
      remainingKm: remainingDistance,
      transportMode: futureMode,
      processingHours,
      lastMileHours,
      confidence: computeEtaConfidence(sorted.length, remainingDistance),
      reason: buildEtaReason({
        remainingDistance,
        mode: futureMode,
        processingHours,
        lastMileHours,
        routeDistanceMinKm,
        routeDistanceMaxKm,
        remainingRangeMinKm,
        remainingRangeMaxKm,
        currentPositionText
      })
    };
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
      if (/^[A-Z]{2}[A-Z]{3}[A-Z]$/.test(cleaned)) {
        const officeAlias = cleaned.slice(2, 5);
        if (state.nodeMap.has(officeAlias)) return officeAlias;
      }
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

      let lat = null;
      let lon = null;
      let layer = null;
      // Attempt to resolve lat/lon from state.nodeMap using the alias
      const resolvedNode = state.nodeMap.get(alias);
      if (resolvedNode) {
        lat = resolvedNode.lat;
        lon = resolvedNode.lon;
        layer = resolvedNode.layer || layer;
      }
      if ((lat === null || lon === null) && progress?.location?.lat && progress?.location?.lon) {
        lat = Number(progress.location.lat);
        lon = Number(progress.location.lon);
      }
      if (!layer) {
        layer = inferLayerFromAlias(alias, location);
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
        timestampMs: date ? date.getTime() : null,
        layer,
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
        return { progresses, trackingData: data };
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
    const parts = [
      `
      <div class="metric">
        <span>경유 노드</span>
        <strong>${result.nodes ?? '--'}</strong>
      </div>`,
      `
      <div class="metric">
        <span>직선 거리</span>
        <strong>${result.directKm?.toFixed ? result.directKm.toFixed(1) + ' km' : '--'}</strong>
      </div>`,
      `
      <div class="metric">
        <span>실제 이동</span>
        <strong>${result.traveledKm?.toFixed ? result.traveledKm.toFixed(1) + ' km' : '--'}</strong>
      </div>`,
      `
      <div class="metric">
        <span>경로 페널티</span>
        <strong>${result.routePenalty !== undefined ? formatPercent(result.routePenalty) : '--'}</strong>
      </div>`,
      `
      <div class="metric">
        <span>대기 페널티</span>
        <strong>${result.dwellPenalty !== undefined ? formatPercent(result.dwellPenalty) : '--'}</strong>
      </div>`,
      `
      <div class="metric">
        <span>EDI 스코어</span>
        <strong>${result.idiotScore !== undefined ? result.idiotScore.toFixed(1) : '--'}</strong>
      </div>`
    ];
    if (result.eta && !result.eta.delivered && result.eta.etaDisplay) {
      if (result.eta.etaRangeDisplay) {
        parts.push(`
      <div class="metric eta">
        <span>예상 배송기간</span>
        <strong>${result.eta.etaRangeDisplay}</strong>
      </div>`);
      }
      parts.push(`
      <div class="metric eta">
        <span>예상 배송완료</span>
        <strong>${result.eta.etaDisplay}</strong>
        ${result.eta.reason ? `<small>${result.eta.reason}</small>` : ''}
      </div>`);
      parts.push(`
      <div class="metric">
        <span>추정 신뢰도</span>
        <strong>${result.eta.confidence || '중간'}</strong>
        ${result.eta.transportMode ? `<small>${MODE_LABELS[result.eta.transportMode] || result.eta.transportMode} 기준</small>` : ''}
      </div>`);
    }
    metricsElement.innerHTML = parts.join('');
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
    const etaInfo = await estimateDeliveryEta(state.trackingEventsIntl, state.trackingRouteHintIntl);
    state.trackingEtaIntl = etaInfo || null;
    if (state.kernel && typeof state.kernel.analyzeTracking === 'function') {
      try {
        const result = JSON.parse(state.kernel.analyzeTracking(payload));
        if (etaInfo && !etaInfo.delivered) {
          result.eta = etaInfo;
        }
        renderTrackingMetrics(trackingMetricsIntl, result);
        const etaLabel = (etaInfo && !etaInfo.delivered)
          ? ` · ETA ${etaInfo.etaRangeDisplay || etaInfo.etaDisplay || ''}` : '';
        setTrackingStatus(trackingStatusIntl, `분석 완료: EDI ${result.idiotScore?.toFixed ? result.idiotScore.toFixed(1) : '--'}${etaLabel}`, 'success');
      } catch (err) {
        setTrackingStatus(trackingStatusIntl, '분석 실패: ' + err.message, 'error');
      }
      return;
    }
    if (state.nativeMode) {
      try {
        setTrackingStatus(trackingStatusIntl, '서버 분석 중...');
        const result = await analyzeTrackingNative(payload);
        if (etaInfo && !etaInfo.delivered) {
          result.eta = etaInfo;
        }
        renderTrackingMetrics(trackingMetricsIntl, result);
        const etaLabel = (etaInfo && !etaInfo.delivered)
          ? ` · ETA ${etaInfo.etaRangeDisplay || etaInfo.etaDisplay || ''}` : '';
        setTrackingStatus(trackingStatusIntl, `분석 완료: EDI ${result.idiotScore?.toFixed ? result.idiotScore.toFixed(1) : '--'}${etaLabel}`, 'success');
      } catch (err) {
        setTrackingStatus(trackingStatusIntl, '분석 실패: ' + err.message, 'error');
      }
      return;
    }
    if (etaInfo && !etaInfo.delivered) {
      renderTrackingMetrics(trackingMetricsIntl, {
        nodes: state.trackingEventsIntl.length,
        directKm: etaInfo.remainingKm || 0,
        traveledKm: etaInfo.observedKm ?? computeObservedDistanceKm(state.trackingEventsIntl),
        routePenalty: 0,
        dwellPenalty: 0,
        idiotScore: 0,
        eta: etaInfo
      });
      setTrackingStatus(trackingStatusIntl, `휴리스틱 ETA 추정 완료${etaInfo.etaRangeDisplay ? ` · ${etaInfo.etaRangeDisplay}` : ''}`, 'success');
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
    state.trackingEtaIntl = null;
    state.trackingRouteHintIntl = null;
    const carriers = resolveKoreaPostCarriers(invoice);
    const carrierLabels = carriers.map(c => c.label).join(', ');
    setTrackingStatus(trackingStatusIntl, `한국 우체국 (${carrierLabels})에서 조회 중...`);
    try {
      const trackingPayload = await fetchTrackingEventsIntl(invoice, carriers);
      const rawEvents = Array.isArray(trackingPayload?.progresses) ? trackingPayload.progresses : [];
      const events = enrichTrackingEvents(rawEvents);
      state.trackingEventsIntl = events;
      state.trackingRouteHintIntl = resolveTrackingRouteHint(trackingPayload?.trackingData, events);
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

  bestFromRefreshBtn.addEventListener('click', () => { requestBestFrom().catch(err => console.error(err)); });
  bestToRefreshBtn.addEventListener('click', () => { requestBestTo().catch(err => console.error(err)); });

  setActivePanel(state.uiMode || 'manual');
  window.addEventListener('resize', () => {
    if (mainMapLibre) mainMapLibre.resize();
    if (modalMapLibre) modalMapLibre.resize();
  });
  
  // Call init() last
  init();

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
  if (typeof maplibregl !== 'undefined') {
    const mainMapContainerId = mapContainer ? 'map-container' : (document.getElementById('route-map') ? 'route-map' : null);
    const modalMapContainerId = mapContainerLarge ? 'map-container-large' : (document.getElementById('route-map-large') ? 'route-map-large' : null);
    if (mainMapContainerId) {
      mainMapLibre = initMap(mainMapContainerId);
    }
    if (modalMapContainerId) {
      modalMapLibre = initMap(modalMapContainerId, true);
    }
  } else {
    console.warn('MapLibre unavailable; map rendering is disabled in this environment.');
  }

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
});
