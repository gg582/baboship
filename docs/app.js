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
  trackingRouteHintIntl: null,
  trackingUserDestIso: 'KR'
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

// OpenSky Network API (https://opensky-network.org/apidoc/)
// Anonymous: 400 credits/day, 10-sec resolution, current state only, ~3-5 min between calls
// Registered: 4,000 credits/day, 5-sec resolution, 1-hour history, ~20-30 sec between calls
const OPENSKY_API_BASE = 'https://opensky-network.org/api';
// How far back to look when querying OpenSky arrivals (seconds).
const OPENSKY_LOOKBACK_SECONDS = 12 * 3600; // 12 hours

const TRANSPORT_SPEED_KMH = {
  air: 550,
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

// ─── Postal EDI Routing Code Detection ───────────────────────────────────
// Strings such as "UAIEVCKRSELBAUX60062" are postal dispatch routing identifiers
// (likely UPU CARDIT/RESDIT format), NOT SITA/ARINC Type-B addresses.
// SITA Type-B addresses are 7-8 chars with no digits (e.g. "KLMOPS", "DLHCKG").
//
// Postal routing code structure (example UAIEVCKRSELBAUX60062):
//   UA    – origin postal network / airline code
//   IEV   – origin airport/city (Kyiv)
//   CK    – cargo/handling code
//   KR    – destination country (Korea)
//   SEL   – destination city (Seoul)
//   BAUX  – routing group / handling agent
//   60062 – sequence number
//
// Detection strategy: find uppercase-letter sequences (4+ chars) that contain
// embedded known IATA/city codes, followed by a 4-6 digit sequence number.
// Matches postal routing reference codes: a run of 4+ uppercase letters
// (negative lookbehind ensures it doesn't start mid-word) followed by 4-6 digits
// (negative lookahead ensures the digits aren't part of a longer number).
// Example match: "UAIEVCKRSELBAUX60062" → block="UAIEVCKRSELBAUX", seq="60062"
const POSTAL_ROUTING_CODE_RE = /(?<![A-Z])([A-Z]{4,})(\d{4,6})(?!\d)/g;

// IATA airport codes and postal city codes → ICAO airport codes.
// Postal EDI routing (e.g. UPU CARDIT/RESDIT) uses 3-letter city/airport codes
// that are sometimes city codes (SEL=Seoul) rather than IATA airport codes (ICN).
const IATA_TO_ICAO_MAP = {
  // Korea
  ICN: 'RKSI', GMP: 'RKSS', PUS: 'RKPK', CJU: 'RKPC', SEL: 'RKSI',
  // Japan
  NRT: 'RJAA', HND: 'RJTT', KIX: 'RJBB', NGO: 'RJGG', TYO: 'RJAA',
  OSA: 'RJBB',
  // China
  PEK: 'ZBAA', PVG: 'ZSPD', CAN: 'ZGGG', SHA: 'ZSSS', CTU: 'ZUUU',
  BJS: 'ZBAA', SZX: 'ZGSZ',
  // Hong Kong / Macau
  HKG: 'VHHH',
  // Southeast Asia
  SIN: 'WSSS', KUL: 'WMKK', BKK: 'VTBS', SGN: 'VVTS', HAN: 'VVNB',
  MNL: 'RPLL', CGK: 'WIII', DPS: 'WADD', RGN: 'VYYY',
  // South Asia
  DEL: 'VIDP', BOM: 'VABB', MAA: 'VOMM', CCU: 'VECC',
  // Middle East
  DXB: 'OMDB', AUH: 'OMAA', DOH: 'OTHH', KWI: 'OKBK', BAH: 'OBBI',
  RUH: 'OERK', CAI: 'HECA',
  // Europe – Western
  LHR: 'EGLL', LGW: 'EGKK', MAN: 'EGCC', LON: 'EGLL',
  CDG: 'LFPG', ORY: 'LFPO', PAR: 'LFPG',
  FRA: 'EDDF', MUC: 'EDDM',
  AMS: 'EHAM',
  MAD: 'LEMD',
  FCO: 'LIRF', MXP: 'LIMC', MIL: 'LIMC',
  ZRH: 'LSZH',
  BRU: 'EBBR',
  VIE: 'LOWW',
  LIS: 'LPPT',
  ATH: 'LGAV',
  // Europe – Nordic/Eastern
  ARN: 'ESSA', HEL: 'EFHK', CPH: 'EKCH', OSL: 'ENGM',
  WAW: 'EPWA', PRG: 'LKPR', BUD: 'LHBP',
  SVO: 'UUEE', DME: 'UUDD', MOS: 'UUEE',
  IEV: 'UKBB', KBP: 'UKBB',
  IST: 'LTBA',
  // Africa
  JNB: 'FAOR', CPT: 'FACT', CAI: 'HECA', ADD: 'HAAB', NBO: 'HKJK',
  // Oceania
  SYD: 'YSSY', MEL: 'YMML', BNE: 'YBBN', PER: 'YPPH', AKL: 'NZAA',
  // North America
  JFK: 'KJFK', LAX: 'KLAX', ORD: 'KORD', SFO: 'KSFO', MIA: 'KMIA',
  ATL: 'KATL', DFW: 'KDFW', SEA: 'KSEA', BOS: 'KBOS', LAS: 'KLAS',
  NYC: 'KJFK', CHI: 'KORD',
  YYZ: 'CYYZ', YVR: 'CYVR', YUL: 'CYUL',
  MEX: 'MMMX',
  // South America
  GRU: 'SBGR', SCL: 'SCEL', BOG: 'SKBO', LIM: 'SPJC', EZE: 'SAEZ',
  SAO: 'SBGR'
};

function iataToIcao(code) {
  return IATA_TO_ICAO_MAP[(code || '').toUpperCase()] || null;
}

// Scan a string for all embedded 3-letter codes known from IATA_TO_ICAO_MAP.
// Returns matches in the order they appear, deduped but preserving sequence.
function scanEmbeddedAirportCodes(str) {
  const found = [];
  const seen = new Set();
  for (let i = 0; i <= str.length - 3; i++) {
    const candidate = str.slice(i, i + 3).toUpperCase();
    if (!seen.has(candidate) && IATA_TO_ICAO_MAP[candidate]) {
      found.push(candidate);
      seen.add(candidate);
    }
  }
  return found;
}

// Parse postal EDI routing codes from free text.
// A routing code is a sequence of 4+ uppercase letters followed by 4-6 digits
// (e.g. "UAIEVCKRSELBAUX60062"). Returns an array of parsed entries.
function parsePostalRoutingCodes(text) {
  if (!text || typeof text !== 'string') return [];
  const results = [];
  let m;
  POSTAL_ROUTING_CODE_RE.lastIndex = 0;
  while ((m = POSTAL_ROUTING_CODE_RE.exec(text)) !== null) {
    const block = m[1];
    const sequence = m[2];
    const airports = scanEmbeddedAirportCodes(block);
    if (airports.length >= 1) {
      results.push({ raw: m[0], block, sequence, airports });
    }
  }
  return results;
}

// Top-level extractor: returns route hint {originCode, destCode, allCodes, rawCodes}
// or null when no routing codes with recognisable airport codes are found.
function extractRouteFromPostalCodes(data) {
  const text = JSON.stringify(data);
  const codes = parsePostalRoutingCodes(text);
  if (!codes.length) return null;
  const allAirports = [];
  for (const rc of codes) allAirports.push(...rc.airports);
  const unique = [...new Set(allAirports)].filter(Boolean);
  if (!unique.length) return null;
  return {
    rawCodes: codes.map(r => r.raw),
    originCode: unique[0],
    destCode: unique[unique.length - 1],
    allCodes: unique
  };
}


// Credentials are stored in localStorage as plain text (no encryption).
// Users should use a dedicated OpenSky account, NOT their primary password.
// A visible warning is shown in the UI when the registered mode is selected.
const OPENSKY_CREDS_KEY = 'baboship_opensky_creds';

function getOpenSkyCredentials() {
  try {
    const raw = localStorage.getItem(OPENSKY_CREDS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) { /* ignore */ }
  return { username: '', password: '' };
}

function saveOpenSkyCredentials(username, password) {
  try {
    localStorage.setItem(OPENSKY_CREDS_KEY, JSON.stringify({ username, password }));
  } catch (_) { /* ignore */ }
}

function clearOpenSkyCredentials() {
  try { localStorage.removeItem(OPENSKY_CREDS_KEY); } catch (_) { /* ignore */ }
}

function isOpenSkyAuthenticated() {
  const { username, password } = getOpenSkyCredentials();
  return !!(username && password);
}

function getOpenSkyHeaders() {
  const { username, password } = getOpenSkyCredentials();
  if (username && password) {
    return { Authorization: 'Basic ' + btoa(`${username}:${password}`) };
  }
  return {};
}

// ─── OpenSky Network – API Calls ─────────────────────────────────────────
// Rate-limit guidance (2026):
//   Anonymous  : ~3-5 min interval; 400 credits/day; 10-sec resolution
//   Registered : ~20-30 sec interval; 4,000 credits/day; 5-sec resolution
// Cost per call:
//   /states/all (worldwide)    : 4 credits
//   /states/all?icao24=…       : 1 credit   ← prefer this
//   /flights/arrival or departure: 1 credit (registered only)

async function fetchOpenSkyStateByIcao24(icao24) {
  const url = `${OPENSKY_API_BASE}/states/all?icao24=${encodeURIComponent(icao24.toLowerCase())}`;
  const resp = await fetch(url, { headers: getOpenSkyHeaders() });
  if (resp.status === 429) throw new Error('OpenSky 호출 한도 초과 (HTTP 429). 잠시 후 다시 시도하세요.');
  if (!resp.ok) throw new Error(`OpenSky HTTP ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data?.states) ? data.states : [];
}

async function fetchOpenSkyArrivals(icaoAirport, beginTs, endTs) {
  if (!isOpenSkyAuthenticated()) return [];
  const url = `${OPENSKY_API_BASE}/flights/arrival?airport=${encodeURIComponent(icaoAirport)}&begin=${beginTs}&end=${endTs}`;
  const resp = await fetch(url, { headers: getOpenSkyHeaders() });
  if (resp.status === 429) throw new Error('OpenSky 호출 한도 초과 (HTTP 429).');
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`OpenSky HTTP ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

async function fetchOpenSkyDepartures(icaoAirport, beginTs, endTs) {
  if (!isOpenSkyAuthenticated()) return [];
  const url = `${OPENSKY_API_BASE}/flights/departure?airport=${encodeURIComponent(icaoAirport)}&begin=${beginTs}&end=${endTs}`;
  const resp = await fetch(url, { headers: getOpenSkyHeaders() });
  if (resp.status === 429) throw new Error('OpenSky 호출 한도 초과 (HTTP 429).');
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`OpenSky HTTP ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

// Bounding-box query for anonymous mode (4 credits).
// Bbox airport lookup radiuses (degrees): ~0.5° ≈ 55 km – covers most airport approach zones.
async function fetchOpenSkyStatesByBbox(lamin, lomin, lamax, lomax) {
  const params = new URLSearchParams({
    lamin: lamin.toFixed(4),
    lomin: lomin.toFixed(4),
    lamax: lamax.toFixed(4),
    lomax: lomax.toFixed(4)
  });
  const url = `${OPENSKY_API_BASE}/states/all?${params}`;
  const resp = await fetch(url, { headers: getOpenSkyHeaders() });
  if (resp.status === 429) throw new Error('OpenSky 호출 한도 초과 (HTTP 429). 잠시 후 다시 시도하세요.');
  if (!resp.ok) throw new Error(`OpenSky HTTP ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data?.states) ? data.states : [];
}

// ─── OpenSky State Vector helpers ────────────────────────────────────────
// OpenSky state vector index positions (from API docs):
// [0]=icao24 [1]=callsign [2]=origin_country [3]=time_position [4]=last_contact
// [5]=longitude [6]=latitude [7]=baro_altitude [8]=on_ground [9]=velocity
// [10]=true_track [11]=vertical_rate [12]=sensors [13]=geo_altitude
// [14]=squawk [15]=spi [16]=position_source
function stateVectorToObject(sv) {
  if (!Array.isArray(sv) || sv.length < 9) return null;
  return {
    icao24: sv[0],
    callsign: (sv[1] || '').trim(),
    originCountry: sv[2],
    lat: sv[6],
    lon: sv[5],
    baroAltitudeM: sv[7],
    onGround: sv[8],
    velocityMs: sv[9],
    trueTrack: sv[10],
    verticalRateMs: sv[11],
    lastContact: sv[4]
  };
}

// ─── Adaptive Polling State ───────────────────────────────────────────────
const openSkyPolling = {
  timerId: null,
  icao24: null,
  onUpdate: null,
  consecutiveErrors: 0
};

// Upsert an OpenSky-derived event into an events array, keyed by icao24.
// Replaces an existing entry for the same aircraft, or appends if none exists.
function upsertOpenSkyEvent(events, newEvent) {
  const idx = events.findIndex(e => e.openSkyIcao24 === newEvent.openSkyIcao24);
  if (idx >= 0) { events[idx] = newEvent; } else { events.push(newEvent); }
}

function stopOpenSkyPolling() {
  if (openSkyPolling.timerId !== null) {
    clearTimeout(openSkyPolling.timerId);
    openSkyPolling.timerId = null;
  }
  openSkyPolling.icao24 = null;
  openSkyPolling.onUpdate = null;
  openSkyPolling.consecutiveErrors = 0;
}

function scheduleOpenSkyPoll(icao24, onUpdate, intervalMs) {
  openSkyPolling.icao24 = icao24;
  openSkyPolling.onUpdate = onUpdate;
  openSkyPolling.timerId = setTimeout(async () => {
    try {
      const states = await fetchOpenSkyStateByIcao24(icao24);
      const sv = states.length ? stateVectorToObject(states[0]) : null;
      openSkyPolling.consecutiveErrors = 0;
      if (sv) {
        onUpdate({ type: 'position', sv });
        if (sv.onGround) {
          onUpdate({ type: 'landed', sv });
          stopOpenSkyPolling();
          return;
        }
        // Adaptive interval: near ground (<3000 m) → 30 s; cruising → 5 min
        // Use baroAltitudeM only; verticalRateMs is climb rate (m/s), not altitude.
        const altitude = sv.baroAltitudeM ?? 10000;
        const nextMs = (typeof altitude === 'number' && altitude < 3000) ? 30_000 : 300_000;
        scheduleOpenSkyPoll(icao24, onUpdate, nextMs);
      } else {
        scheduleOpenSkyPoll(icao24, onUpdate, 300_000);
      }
    } catch (err) {
      openSkyPolling.consecutiveErrors++;
      if (openSkyPolling.consecutiveErrors < 3) {
        scheduleOpenSkyPoll(icao24, onUpdate, 300_000);
      } else {
        stopOpenSkyPolling();
      }
    }
  }, intervalMs);
}

function startOpenSkyAdaptivePolling(icao24, onUpdate) {
  stopOpenSkyPolling();
  const initialMs = isOpenSkyAuthenticated() ? 30_000 : 300_000;
  scheduleOpenSkyPoll(icao24, onUpdate, initialMs);
}

// ─── Postal EDI Routing → OpenSky Flight Detection ───────────────────────
// When the Korea Post API response contains a postal routing reference code
// (e.g. UPU CARDIT/RESDIT dispatch identifier like "UAIEVCKRSELBAUX60062"),
// we parse the embedded airport codes to infer origin/destination, then query
// OpenSky for cargo flights on the actual hub-connected route.
//
// Important: a routing code like IEV→SEL does NOT imply a direct flight.
// Typical Ukraine→Korea EMS route: Kyiv → Warsaw/Riga/Frankfurt → Incheon.
// We therefore expand the origin→destination pair into a hub-aware waypoint list
// and query OpenSky at the cargo destination (ICN) where we can observe arrival.

// Known EMS transit hubs used by major postal regions.
// When origin and destination are on different continents, cargo typically
// transits through one of these hubs before the final leg.
const EMS_HUB_ROUTES = [
  { originRegion: ['IEV', 'KBP', 'WAW', 'RIX', 'VNO'], destRegion: ['ICN', 'GMP', 'SEL', 'KR'], hubs: ['WAW', 'FRA', 'AMS', 'LHR'] },
  { originRegion: ['FRA', 'LHR', 'CDG', 'AMS', 'MUC', 'ZRH', 'VIE', 'BRU', 'MAD', 'FCO'], destRegion: ['ICN', 'GMP', 'SEL', 'KR'], hubs: ['FRA', 'AMS', 'HEL'] },
  { originRegion: ['JFK', 'LAX', 'ORD', 'SFO', 'MIA', 'ATL', 'NYC'], destRegion: ['ICN', 'GMP', 'SEL', 'KR'], hubs: ['NRT', 'PVG'] },
  { originRegion: ['NRT', 'HND', 'TYO', 'KIX', 'OSA', 'NGO'], destRegion: ['ICN', 'GMP', 'SEL', 'KR'], hubs: [] },
  { originRegion: ['PVG', 'PEK', 'CAN', 'SHA', 'BJS', 'SZX', 'CTU'], destRegion: ['ICN', 'GMP', 'SEL', 'KR'], hubs: [] }
];

function resolveHubWaypoints(originCode, destCode) {
  const oc = (originCode || '').toUpperCase();
  const dc = (destCode || '').toUpperCase();
  for (const rule of EMS_HUB_ROUTES) {
    if (rule.originRegion.includes(oc) && rule.destRegion.includes(dc)) {
      return rule.hubs;
    }
  }
  return [];
}

async function detectPostalRoutingAndEnrich(rawTrackingData) {
  const route = extractRouteFromPostalCodes(rawTrackingData);
  if (!route) return { detected: false };

  const { originCode, destCode, allCodes, rawCodes } = route;
  const hubs = resolveHubWaypoints(originCode, destCode);

  // The airport we actually query on OpenSky is the final cargo destination.
  // For Korea-bound mail this is always ICN (RKSI).
  const queryIata = destCode || allCodes[allCodes.length - 1];
  const queryIcao = iataToIcao(queryIata);
  if (!queryIcao) {
    return { detected: true, originCode, destCode, hubs, rawCodes, openSkyEvents: [] };
  }

  const nowTs = Math.floor(Date.now() / 1000);
  const beginTs = nowTs - OPENSKY_LOOKBACK_SECONDS;

  let matchedFlights = [];
  let openSkyEvents = [];
  let openSkyError = null;

  try {
    if (isOpenSkyAuthenticated()) {
      // Registered: arrivals API at destination (1 credit) – most accurate.
      matchedFlights = await fetchOpenSkyArrivals(queryIcao, beginTs, nowTs);
    } else {
      // Anonymous: bounding-box query at destination airport (4 credits).
      const nodeEntry = state.nodeMap.get(queryIata)
        || state.nodeMap.get(queryIcao)
        || HARD_CODED_NODE_FALLBACKS[queryIata];
      if (nodeEntry) {
        const d = 0.5; // ≈55 km radius
        const svList = await fetchOpenSkyStatesByBbox(
          nodeEntry.lat - d, nodeEntry.lon - d,
          nodeEntry.lat + d, nodeEntry.lon + d
        );
        openSkyEvents = svList.map(stateVectorToObject).filter(Boolean);
      }
    }
  } catch (err) {
    console.warn('OpenSky enrichment failed:', err.message);
    openSkyError = err.message;
  }

  // Build synthetic tracking events from OpenSky data
  const syntheticEvents = [];

  for (const sv of openSkyEvents) {
    if (!sv || sv.lat == null || sv.lon == null) continue;
    syntheticEvents.push({
      alias: sv.callsign || sv.icao24,
      countryCode: sv.originCountry || '',
      locationName: sv.onGround
        ? `착륙 확인 (${sv.callsign || sv.icao24})`
        : `비행 중 (${sv.callsign || sv.icao24})`,
      statusText: sv.onGround
        ? `지상 확인 · ICAO24 ${sv.icao24}`
        : `고도 ${sv.baroAltitudeM != null ? Math.round(sv.baroAltitudeM) + ' m' : '--'} · ${sv.velocityMs != null ? Math.round(sv.velocityMs * 3.6) + ' km/h' : '--'}`,
      statusCode: sv.onGround ? 'OS_LANDED' : 'OS_AIRBORNE',
      timestampToken: String(sv.lastContact || ''),
      safetyStatus: 'OPENSKY',
      displayTime: sv.lastContact ? new Date(sv.lastContact * 1000).toLocaleString() : '--',
      timestampMs: sv.lastContact ? sv.lastContact * 1000 : null,
      layer: 'air',
      lat: sv.lat,
      lon: sv.lon,
      openSkyIcao24: sv.icao24,
      raw: sv
    });
  }

  for (const flight of matchedFlights) {
    if (!flight) continue;
    syntheticEvents.push({
      alias: flight.callsign || flight.icao24,
      countryCode: '',
      locationName: `OpenSky 도착 기록 (${flight.callsign || flight.icao24})`,
      statusText: [
        flight.estDepartureAirport ? `출발: ${flight.estDepartureAirport}` : null,
        flight.estArrivalAirport ? `도착: ${flight.estArrivalAirport}` : null
      ].filter(Boolean).join(' → ') || 'OpenSky 운항 이력',
      statusCode: 'OS_ARRIVAL',
      timestampToken: String(flight.lastSeen || flight.firstSeen || ''),
      safetyStatus: 'OPENSKY',
      displayTime: flight.lastSeen ? new Date(flight.lastSeen * 1000).toLocaleString() : '--',
      timestampMs: flight.lastSeen ? flight.lastSeen * 1000 : null,
      layer: 'air',
      lat: null,
      lon: null,
      openSkyIcao24: flight.icao24,
      raw: flight
    });
  }

  return {
    detected: true,
    rawCodes,
    originCode,
    destCode,
    hubs,
    queryIcao,
    openSkyEvents: syntheticEvents,
    openSkyError,
    firstIcao24: openSkyEvents[0]?.openSkyIcao24 || matchedFlights[0]?.icao24 || null
  };
}

const MALFORMED_JSON_REPAIR_MODULE_URL = 'https://cdn.jsdelivr.net/npm/jsonrepair@3.11.0/+esm';
const CALENDAR_LIB_MODULE_URL = 'https://cdn.jsdelivr.net/npm/dayjs@1.11.13/+esm';
let jsonRepairFunction = null;
let jsonRepairImportPromise = null;
let dayjsFunction = null;
let dayjsImportPromise = null;
const TOP_ROUTE_MAX_TRANSFERS = 5;
const TOP_ROUTE_CANDIDATE_LIMIT = 24;
const TOP_ROUTE_TAKE = 5;
const PENDING_DESTINATION_CUSTOMS_HOURS = 96;
// Extra upper-bound buffer applied to the ETA range when no departure scan has
// been observed yet.  120 h = 5 days covers typical outbound-queue variance.
const PRE_DEPARTURE_DELAY_MAX_HOURS = 120;

// ---------------------------------------------------------------------------
// Public holidays by ISO country code (2025–2026).
// Each entry is a Set of 'YYYY-MM-DD' strings in the UTC calendar.
// Weekends are handled separately in isBusinessDay(); these Sets contain only
// named public / bank holidays (non-weekend days that suspend operations).
// ---------------------------------------------------------------------------
const COUNTRY_HOLIDAYS = (() => {
  const d = {};
  const mk = (...dates) => new Set(dates);

  // Korea (관세청·우체국 공휴일)
  d['KR'] = mk(
    '2025-01-01','2025-01-28','2025-01-29','2025-01-30',
    '2025-03-01','2025-05-05','2025-05-06','2025-06-06',
    '2025-08-15','2025-10-03','2025-10-06','2025-10-07',
    '2025-10-08','2025-10-09','2025-12-25',
    '2026-01-01','2026-02-17','2026-02-18','2026-02-19',
    '2026-03-01','2026-03-02','2026-05-05','2026-06-06',
    '2026-08-15','2026-09-24','2026-09-25','2026-09-26',
    '2026-10-03','2026-10-09','2026-12-25'
  );

  // Germany (Zoll / Deutsche Post – federal holidays only)
  d['DE'] = mk(
    '2025-01-01','2025-04-18','2025-04-21','2025-05-01',
    '2025-05-29','2025-06-09','2025-10-03','2025-12-25','2025-12-26',
    '2026-01-01','2026-04-03','2026-04-06','2026-05-01',
    '2026-05-14','2026-05-25','2026-10-03','2026-12-25','2026-12-26'
  );

  // United States (USPS federal holidays)
  d['US'] = mk(
    '2025-01-01','2025-01-20','2025-02-17','2025-05-26',
    '2025-06-19','2025-07-04','2025-09-01','2025-10-13',
    '2025-11-11','2025-11-27','2025-12-25',
    '2026-01-01','2026-01-19','2026-02-16','2026-05-25',
    '2026-06-19','2026-07-03','2026-09-07','2026-10-12',
    '2026-11-11','2026-11-26','2026-12-25'
  );

  // Japan (日本郵便 national holidays)
  d['JP'] = mk(
    '2025-01-01','2025-01-13','2025-02-11','2025-02-23',
    '2025-03-20','2025-04-29','2025-05-03','2025-05-04',
    '2025-05-05','2025-07-21','2025-08-11','2025-09-15',
    '2025-09-23','2025-10-13','2025-11-03','2025-11-23','2025-11-24',
    '2026-01-01','2026-01-12','2026-02-11','2026-02-23',
    '2026-03-20','2026-04-29','2026-05-03','2026-05-04',
    '2026-05-05','2026-05-06','2026-07-20','2026-08-11',
    '2026-09-21','2026-09-22','2026-09-23','2026-10-12',
    '2026-11-03','2026-11-23'
  );

  // China (海关 / 中国邮政 – golden week & national holidays)
  d['CN'] = mk(
    '2025-01-01',
    '2025-01-28','2025-01-29','2025-01-30','2025-01-31',
    '2025-02-03','2025-02-04',
    '2025-04-04','2025-04-05','2025-04-07',
    '2025-05-01','2025-05-02','2025-05-05',
    '2025-05-31','2025-06-01','2025-06-02',
    '2025-10-01','2025-10-02','2025-10-03','2025-10-04',
    '2025-10-05','2025-10-06','2025-10-07','2025-10-08',
    '2026-01-01',
    '2026-02-17','2026-02-18','2026-02-19','2026-02-20',
    '2026-02-23','2026-02-24',
    '2026-04-04','2026-04-06',
    '2026-05-01','2026-05-04','2026-05-05',
    '2026-10-01','2026-10-02','2026-10-03','2026-10-04',
    '2026-10-05','2026-10-06','2026-10-07','2026-10-08'
  );

  // United Kingdom (Royal Mail bank holidays – England & Wales)
  d['GB'] = mk(
    '2025-01-01','2025-04-18','2025-04-21','2025-05-05',
    '2025-05-26','2025-08-25','2025-12-25','2025-12-26',
    '2026-01-01','2026-04-03','2026-04-06','2026-05-04',
    '2026-05-25','2026-08-31','2026-12-25','2026-12-28'
  );

  // France (La Poste jours fériés)
  d['FR'] = mk(
    '2025-01-01','2025-04-21','2025-05-01','2025-05-08',
    '2025-05-29','2025-06-09','2025-07-14','2025-08-15',
    '2025-11-01','2025-11-11','2025-12-25',
    '2026-01-01','2026-04-06','2026-05-01','2026-05-08',
    '2026-05-14','2026-05-25','2026-07-14','2026-08-15',
    '2026-11-01','2026-11-11','2026-12-25'
  );

  // Australia (Australia Post – nationwide + NSW)
  d['AU'] = mk(
    '2025-01-01','2025-01-27','2025-04-18','2025-04-19',
    '2025-04-20','2025-04-21','2025-04-25','2025-06-09',
    '2025-12-25','2025-12-26',
    '2026-01-01','2026-01-26','2026-04-03','2026-04-05',
    '2026-04-06','2026-04-25','2026-06-08','2026-12-25','2026-12-28'
  );

  // Canada (Canada Post federal statutory holidays)
  d['CA'] = mk(
    '2025-01-01','2025-02-17','2025-04-18','2025-05-19',
    '2025-07-01','2025-08-04','2025-09-01','2025-10-13',
    '2025-11-11','2025-12-25','2025-12-26',
    '2026-01-01','2026-02-16','2026-04-03','2026-05-18',
    '2026-07-01','2026-09-07','2026-10-12',
    '2026-11-11','2026-12-25','2026-12-28'
  );

  // Singapore (SingPost public holidays)
  d['SG'] = mk(
    '2025-01-01','2025-01-29','2025-01-30','2025-03-31',
    '2025-04-18','2025-05-01','2025-05-12','2025-06-07',
    '2025-08-09','2025-10-20','2025-12-25',
    '2026-01-01','2026-01-17','2026-01-18','2026-03-20',
    '2026-04-03','2026-05-01','2026-06-26',
    '2026-08-09','2026-11-08','2026-12-25'
  );

  // Hong Kong (Hongkong Post public holidays)
  d['HK'] = mk(
    '2025-01-01','2025-01-29','2025-01-30','2025-01-31',
    '2025-04-04','2025-04-18','2025-04-19','2025-04-21',
    '2025-05-01','2025-05-05','2025-05-31','2025-07-01',
    '2025-10-01','2025-10-07','2025-11-26',
    '2025-12-25','2025-12-26',
    '2026-01-01','2026-02-17','2026-02-18','2026-02-19',
    '2026-04-03','2026-04-05','2026-04-06','2026-05-01',
    '2026-05-24','2026-06-20','2026-07-01',
    '2026-10-01','2026-10-26','2026-12-25','2026-12-26'
  );

  // Italy (Poste Italiane festività nazionali)
  d['IT'] = mk(
    '2025-01-01','2025-01-06','2025-04-21','2025-04-25',
    '2025-05-01','2025-06-02','2025-08-15','2025-11-01',
    '2025-12-08','2025-12-25','2025-12-26',
    '2026-01-01','2026-01-06','2026-04-06','2026-04-25',
    '2026-05-01','2026-06-02','2026-08-15','2026-11-01',
    '2026-12-08','2026-12-25','2026-12-26'
  );

  // Netherlands (PostNL nationale feestdagen)
  d['NL'] = mk(
    '2025-01-01','2025-04-18','2025-04-21','2025-04-26',
    '2025-05-05','2025-05-29','2025-06-09','2025-12-25','2025-12-26',
    '2026-01-01','2026-04-03','2026-04-06','2026-04-25',
    '2026-05-14','2026-05-25','2026-12-25','2026-12-26'
  );

  // Sweden (PostNord helgdagar)
  d['SE'] = mk(
    '2025-01-01','2025-01-06','2025-04-18','2025-04-21',
    '2025-05-01','2025-05-29','2025-06-06','2025-06-21',
    '2025-11-01','2025-12-25','2025-12-26',
    '2026-01-01','2026-01-06','2026-04-03','2026-04-06',
    '2026-05-01','2026-05-14','2026-06-06','2026-06-20',
    '2026-11-07','2026-12-25','2026-12-26'
  );

  // UAE (Emirates Post public holidays – approximate)
  d['AE'] = mk(
    '2025-01-01','2025-03-28','2025-03-29','2025-03-30',
    '2025-04-18','2025-05-01','2025-06-06','2025-06-07',
    '2025-06-25','2025-06-26','2025-07-04','2025-12-01','2025-12-02',
    '2026-01-01','2026-03-17','2026-03-18','2026-03-19',
    '2026-05-01','2026-05-26','2026-05-27',
    '2026-06-14','2026-06-15','2026-11-30','2026-12-01','2026-12-02'
  );

  // Thailand (Thailand Post วันหยุดราชการ)
  d['TH'] = mk(
    '2025-01-01','2025-02-12','2025-04-06','2025-04-13',
    '2025-04-14','2025-04-15','2025-05-01','2025-05-05',
    '2025-05-12','2025-06-03','2025-07-10','2025-07-28',
    '2025-08-12','2025-10-13','2025-10-23','2025-12-05','2025-12-10','2025-12-31',
    '2026-01-01','2026-02-01','2026-04-06','2026-04-13',
    '2026-04-14','2026-04-15','2026-05-01','2026-05-11',
    '2026-05-25','2026-06-03','2026-07-01','2026-07-27',
    '2026-08-12','2026-10-13','2026-10-23','2026-12-05','2026-12-10','2026-12-31'
  );

  // Malaysia (Pos Malaysia – nationwide federal holidays)
  d['MY'] = mk(
    '2025-01-01','2025-01-29','2025-01-30','2025-02-01',
    '2025-03-28','2025-04-18','2025-05-01','2025-05-12',
    '2025-06-02','2025-06-07','2025-08-31','2025-09-16',
    '2025-10-20','2025-12-25',
    '2026-01-01','2026-02-17','2026-02-18',
    '2026-03-17','2026-04-03','2026-05-01',
    '2026-05-25','2026-05-31','2026-08-31',
    '2026-09-16','2026-11-08','2026-12-25'
  );

  return d;
})();

// ---------------------------------------------------------------------------
// Business-day calendar helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the given UTC date is a working day for the specified
 * country: not a Saturday, not a Sunday, and not a listed public holiday.
 *
 * Saturday counts as a working day when `includeSaturday` is true (used for
 * postal last-mile delivery which typically runs Mon–Sat).
 *
 * @param {Date|number} dateOrMs  - UTC Date object or Unix timestamp (ms)
 * @param {string}      iso       - ISO-3166-1 alpha-2 country code
 * @param {boolean}     includeSaturday
 * @returns {boolean}
 */
function isBusinessDay(dateOrMs, iso, includeSaturday = false) {
  const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  if (dow === 0) return false; // always closed on Sunday
  if (dow === 6 && !includeSaturday) return false;
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return !(COUNTRY_HOLIDAYS[iso] || new Set()).has(key);
}

/**
 * Advances `startMs` by `hours` worth of effective working hours, skipping
 * weekends and public holidays for `iso`.  The entire 24h of each working day
 * is counted (customs/sorting facilities run round-the-clock on business days).
 * When `includeSaturday` is true Saturday is treated as a working day (last-
 * mile postal delivery model).
 *
 * Returns the resulting calendar timestamp (ms).
 *
 * @param {number}  startMs
 * @param {number}  hours            effective working hours to add
 * @param {string}  iso              ISO-3166-1 alpha-2 country code
 * @param {boolean} includeSaturday
 * @returns {number}
 */
function addBusinessHoursCalendar(startMs, hours, iso, includeSaturday = false) {
  if (!Number.isFinite(startMs) || !Number.isFinite(hours) || hours <= 0) {
    return startMs;
  }
  let current = startMs;
  let remaining = hours;
  let guard = 0;
  const MAX_GUARD = Math.ceil(hours) + 366 * 24; // worst case: one holiday per day for a year
  while (remaining > 0 && guard < MAX_GUARD) {
    guard++;
    const d = new Date(current);
    if (!isBusinessDay(d, iso, includeSaturday)) {
      // Skip to the start of the next UTC day
      const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      current = next;
      continue;
    }
    // Working day: consume until end of this UTC day
    const endOfDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    const hoursLeft = (endOfDay - current) / 3600000;
    if (remaining <= hoursLeft) {
      current += remaining * 3600000;
      remaining = 0;
    } else {
      remaining -= hoursLeft;
      current = endOfDay;
    }
  }
  return current;
}

const SEA_KEYWORDS = [/PORT/i, /TERMINAL/i, /WHARF/i, /부두/, /항\b/, /碼頭/];
const LAND_KEYWORDS = [/허브/, /센터/, /물류/, /소포/, /delivery/i, /hub/i];
const DELIVERED_PATTERNS = [/배달완료/, /배송완료/, /수취완료/, /delivered/i];

// UPU S10 service indicator ranges (first two letters of tracking number).
// Reference: UPU S10 standard, Table B1.
const UPU_S10_SERVICE_CLASSES = [
  // AA–AZ: reserved / air-mail letter post (included for completeness)
  { range: ['AA', 'AZ'], serviceClass: 'air',            label: '항공 우편' },
  { range: ['CA', 'CZ'], serviceClass: 'parcel',         label: '등기 소포' },
  { range: ['EA', 'EZ'], serviceClass: 'ems',            label: 'EMS' },
  { range: ['LA', 'LZ'], serviceClass: 'letter_tracked', label: '추적 서신' },
  { range: ['RA', 'RZ'], serviceClass: 'registered',     label: '등기 우편' },
  { range: ['VA', 'VZ'], serviceClass: 'parcel',         label: '우편 소포' }
];

// Single combined regex for departure/in-transit milestones (fast O(n) scan).
const DEPARTURE_RE = /출국|출발|항공기.*적재|적재.*항공기|in.?transit|departed|dispatch|발송완료|발송됨|통관.*통과|아웃바운드|항공.*탑재|탑재.*완료/i;
function clampNumber(value, min, max) {
  const num = Number(value);
  if (Number.isNaN(num)) return min;
  if (typeof min === 'number' && num < min) return min;
  if (typeof max === 'number' && num > max) return max;
  return num;
}

/**
 * Classify a UPU S10 tracking number by its two-letter service indicator.
 * Returns the matching entry from UPU_S10_SERVICE_CLASSES, or null if the
 * number does not match the UPU S10 format.
 */
function classifyUPUS10ServiceClass(invoice) {
  const normalized = (invoice || '').trim().toUpperCase();
  // UPU S10: 2-letter service indicator + 8-digit serial + 1 check digit + 2-letter country code
  const m = normalized.match(/^([A-Z]{2})\d{8}\d[A-Z]{2}$/);
  if (!m) return null;
  const prefix = m[1];
  for (const entry of UPU_S10_SERVICE_CLASSES) {
    const [lo, hi] = entry.range;
    if (prefix >= lo && prefix <= hi) return entry;
  }
  return null;
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
  const trackingDestinationSelect = document.getElementById('tracking-destination-iso');
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

  /**
   * Returns true when none of the enriched events contains a departure/in-transit
   * milestone scan.  In this state the shipment has not yet left the origin country,
   * so any ETA estimate carries large uncertainty and should be labelled accordingly.
   */
  function isPreDepartureState(events) {
    if (!Array.isArray(events) || !events.length) return true;
    return !events.some(evt => DEPARTURE_RE.test(evt.statusText || ''));
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
        hours += 72;
      } else {
        hours += 48;
      }
    }
    if (/발송준비/.test(text)) {
      hours += 48;
    }
    if (/통관/.test(text)) {
      hours += /완료/.test(text) ? 12 : 48;
    }
    if (/배달준비|배송준비|집배준비/.test(text)) {
      hours += 6;
    }
    if (/배달중/.test(text)) {
      hours += 3;
    }
    return hours;
  }

  function computePendingDestinationCustomsHours(events, lastEvent, targetIso) {
    if (!lastEvent || !targetIso) return 0;
    const lastIso = (lastEvent.countryCode || '').toUpperCase();
    const destIso = targetIso.toUpperCase();
    if (lastIso === destIso) return 0;
    const hasDestinationCustomsEvent = (events || []).some((evt) => {
      const iso = (evt.countryCode || '').toUpperCase();
      if (iso !== destIso) return false;
      return /통관/.test(evt.statusText || '');
    });
    if (hasDestinationCustomsEvent) return 0;
    return PENDING_DESTINATION_CUSTOMS_HOURS;
  }

  function determineLastMileHours(targetIso, lastIso) {
    const normalizedTarget = (targetIso || DEFAULT_DESTINATION_ISO).toUpperCase();
    const normalizedLast = (lastIso || '').toUpperCase();
    if (normalizedTarget === 'KR' && normalizedLast === 'KR') {
      return 24;
    }
    if (normalizedTarget && normalizedTarget === normalizedLast) {
      return 24;
    }
    return 72;
  }

  function computeEtaConfidence(eventCount, remainingDistance, preDeparture = false) {
    if (preDeparture) return '낮음';
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
    if (detail.destinationCustomsHours) {
      parts.push(`도착통관 예상 ${Math.round(detail.destinationCustomsHours)}시간`);
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

  function resolveDestinationHub(events, lastEvent, userIso = null) {
    // User-specified destination takes priority
    if (userIso) {
      const userHub = resolveCountryHubNode(userIso.toUpperCase());
      if (userHub) return userHub;
    }
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

  async function estimateDeliveryEta(events, routeHint = null, userDestIso = null) {
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

    // Detect whether the shipment has not yet departed the origin country.
    // When pre-departure, only origin-exchange-office scans exist; any ETA carries
    // high uncertainty and must be accompanied by a wider range.
    const preDeparture = isPreDepartureState(events);

    // Resolve destination, honouring the user-selected ISO code
    const effectiveUserIso = (userDestIso || state.trackingUserDestIso || '').toUpperCase() || null;
    const destination = resolveDestinationHub(events, lastEvent, effectiveUserIso);
    if (!destination || typeof lastEvent.timestampMs !== 'number') return null;

    // When the user picked a destination, inject it into the route-hint if not already set
    if (effectiveUserIso && destination.code && !routeHint?.destinationCode) {
      routeHint = { ...(routeHint || {}), destinationCode: destination.code };
    }
    // Similarly try to infer origin from the first event when missing
    if (routeHint && !routeHint.originCode && sorted.length) {
      const firstEvt = sorted[0];
      const inferredOrigin = extractRouteAlias(firstEvt.alias, firstEvt.countryCode);
      if (inferredOrigin && inferredOrigin !== routeHint.destinationCode) {
        routeHint = { ...routeHint, originCode: inferredOrigin };
      }
    }

    let remainingDistance = 0;
    if (typeof lastEvent.lat === 'number' && typeof lastEvent.lon === 'number') {
      remainingDistance = haversineKm(lastEvent.lat, lastEvent.lon, destination.lat, destination.lon);
    }
    if (!Number.isFinite(remainingDistance)) remainingDistance = 0;
    const futureMode = determineFutureMode(lastEvent, destination, events);
    const speed = TRANSPORT_SPEED_KMH[futureMode] || TRANSPORT_SPEED_KMH.air;
    const remainingTravelHours = remainingDistance > 5 ? (remainingDistance / speed) : 0;
    const processingHours = computePendingProcessingHours(lastEvent);
    const destinationCustomsHours = computePendingDestinationCustomsHours(events, lastEvent, destination.iso);
    const lastMileHours = determineLastMileHours(destination.iso, lastEvent.countryCode);
    const destIso = (destination.iso || effectiveUserIso || DEFAULT_DESTINATION_ISO).toUpperCase();

    // Travel + origin-exchange-office processing are continuous (24/7)
    const travelAndProcessEndMs = lastEvent.timestampMs + (remainingTravelHours + processingHours) * 3600000;
    // Destination customs: business days only (Mon–Fri, no public holidays in dest country)
    const customsEndMs = addBusinessHoursCalendar(travelAndProcessEndMs, destinationCustomsHours, destIso, false);
    // Last-mile delivery: Mon–Sat, no public holidays in dest country
    const etaTimestampBase = addBusinessHoursCalendar(customsEndMs, lastMileHours, destIso, true);

    if (!Number.isFinite(etaTimestampBase)) return null;
    let etaTimestamp = etaTimestampBase;
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
          const etaTimestampsByCandidate = topCandidates.map((candidate) => {
            const remainingKm = Math.max(candidate.totalDistanceKm - observedDistance, 0);
            const travelHrs = remainingKm > 5 ? (remainingKm / speed) : 0;
            const candidateTravelEndMs = lastEvent.timestampMs + (travelHrs + processingHours) * 3600000;
            const candidateCustomsEndMs = addBusinessHoursCalendar(candidateTravelEndMs, destinationCustomsHours, destIso, false);
            return addBusinessHoursCalendar(candidateCustomsEndMs, lastMileHours, destIso, true);
          });
          const minTimestamp = Math.min(...etaTimestampsByCandidate);
          const maxTimestamp = Math.max(...etaTimestampsByCandidate);
          etaTimestamp = minTimestamp;
          remainingRangeMinKm = Math.max(routeDistanceMinKm - observedDistance, 0);
          remainingRangeMaxKm = Math.max(routeDistanceMaxKm - observedDistance, 0);
          const projectedTotalKm = observedDistance + remainingRangeMaxKm;
          const progressRatio = projectedTotalKm > 0 ? clampNumber(observedDistance / projectedTotalKm, 0, 1) : 0;
          currentPositionText = `현재 예상 위치 약 ${Math.round(progressRatio * 100)}% 지점`;
          // Pre-departure: widen the upper bound by up to 5 days to reflect
          // the unobserved departure queuing / outbound-flight lead time.
          const maxTimestampWidened = preDeparture
            ? maxTimestamp + PRE_DEPARTURE_DELAY_MAX_HOURS * 3600000
            : maxTimestamp;
          etaRangeDisplay = await formatEtaDateRangeText(minTimestamp, maxTimestampWidened);
        }
      } catch (err) {
        console.warn('Failed to build Top5 route ETA range:', err);
      }
    }
    if (!etaRangeDisplay) {
      // Without route data: in pre-departure state show a range with a 5-day upper buffer.
      const etaMax = preDeparture
        ? etaTimestamp + PRE_DEPARTURE_DELAY_MAX_HOURS * 3600000
        : etaTimestamp;
      etaRangeDisplay = await formatEtaDateRangeText(etaTimestamp, etaMax);
    }
    return {
      delivered: false,
      preDeparture,
      etaTimestamp,
      etaDisplay: formatTimelineTime(new Date(etaTimestamp)),
      etaRangeDisplay,
      observedKm: observedDistanceBase,
      remainingKm: remainingDistance,
      transportMode: futureMode,
      processingHours,
      destinationCustomsHours,
      lastMileHours,
      destIso,
      confidence: computeEtaConfidence(sorted.length, remainingDistance, preDeparture),
      reason: buildEtaReason({
        remainingDistance,
        mode: futureMode,
        processingHours,
        destinationCustomsHours,
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
      if (/^[A-Z]{6}$/.test(cleaned)) {
        const airportCode = cleaned.slice(2, 5);
        if (state.nodeMap.has(airportCode)) return airportCode;
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
      const serviceInfo = classifyUPUS10ServiceClass(normalized);
      // 국제우편은 우체국 EMS 엔드포인트를 우선으로 통일해 404 가능성을 낮춘다.
      pushUnique('kr.epost.ems', 'Korea Post EMS');
      if (serviceInfo?.serviceClass === 'letter_tracked') {
        // Letter 계열은 일반 우체국 API를 보조 후보로 둔다.
        pushUnique('kr.epost', `Korea Post (${serviceInfo.label})`);
      } else if (serviceInfo?.serviceClass === 'parcel') {
        // 소포 계열은(EMS 우선 전제) 일반 우체국 API를 보조 후보로 둔다.
        pushUnique('kr.epost', `Korea Post (${serviceInfo.label})`);
      } else if (serviceInfo?.serviceClass === 'registered') {
        pushUnique('kr.epost', `Korea Post (${serviceInfo.label})`);
      } else {
        pushUnique('kr.epost', 'Korea Post');
        pushUnique('un.upu.ems', 'UPU EMS (fallback)');
      }
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
        // ── Postal routing code detection: scan response for dispatch routing
        // identifiers (e.g. UPU CARDIT/RESDIT). If found, query OpenSky for
        // the cargo flight at the destination airport and merge the result.
        // This is fully non-fatal: any error falls back to Korea Post events only.
        let openSkyMeta = null;
        try {
          openSkyMeta = await detectPostalRoutingAndEnrich(data);
        } catch (_) { /* non-fatal – continue without OpenSky */ }
        return { progresses, trackingData: data, openSkyMeta };
      } catch (err) {
        attemptErrors.push(`${carrier.label}: ${err.message}`);
      }
    }
    const joined = attemptErrors.length ? attemptErrors.join(' / ') : '알 수 없는 오류';
    throw new Error(`우체국 API에 연결하지 못했습니다. ${joined} · 로그를 직접 붙여넣을 수 있습니다.`);
  }

  function buildTrackingPayload(events) {
    if (!events.length) return '';
    return events.map((evt) => {
      const flowTimestamp = Number.isFinite(evt.timestampMs)
        ? Math.floor(evt.timestampMs / 1000)
        : evt.timestampToken;
      return `${evt.alias} ${flowTimestamp || ''} ${evt.statusText || ''}`.trim();
    }).join('\n');
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
      const destIso = result.eta.destIso || '';
      const calNote = destIso && COUNTRY_HOLIDAYS[destIso]
        ? `<small class="cal-note">📅 ${destIso} 영업일·공휴일 반영</small>`
        : '';
      parts.push(`
      <div class="metric eta">
        <span>예상 배송완료</span>
        <strong>${result.eta.etaDisplay}</strong>
        ${result.eta.reason ? `<small>${result.eta.reason}</small>` : ''}
        ${result.eta.preDeparture ? `<small class="warn">⚠️ 출국 전 단계 – 출국 스캔 미관측, 구간 예측 적용</small>` : ''}
        ${calNote}
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
    const userDestIso = (trackingDestinationSelect?.value || state.trackingUserDestIso || 'KR').toUpperCase();
    const etaInfo = await estimateDeliveryEta(state.trackingEventsIntl, state.trackingRouteHintIntl, userDestIso);
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
    const serviceInfo = classifyUPUS10ServiceClass(invoice);
    const serviceLabel = serviceInfo ? ` (${serviceInfo.label})` : '';
    const carrierLabels = carriers.map(c => c.label).join(', ');
    setTrackingStatus(trackingStatusIntl, `${carrierLabels}${serviceLabel}에서 조회 중...`);
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

      // ── OpenSky merge (non-fatal): if postal routing was detected and
      // OpenSky returned supplementary flight events, append them and re-render.
      // On any failure the original Korea Post timeline is preserved.
      try {
        const meta = trackingPayload?.openSkyMeta;
        if (meta?.detected && Array.isArray(meta.openSkyEvents) && meta.openSkyEvents.length) {
          const merged = [...events, ...meta.openSkyEvents]
            .sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
          state.trackingEventsIntl = merged;
          renderTrackingTimeline(trackingTimelineIntl, merged);

          // Start adaptive polling if we identified a specific aircraft (ICAO24).
          if (meta.firstIcao24) {
            stopOpenSkyPolling();
            startOpenSkyAdaptivePolling(meta.firstIcao24, (update) => {
              if (update.type !== 'position' && update.type !== 'landed') return;
              const sv = update.sv;
              const posEvent = {
                alias: sv.callsign || sv.icao24,
                countryCode: sv.originCountry || '',
                locationName: sv.onGround ? `착륙 확인 (${sv.callsign || sv.icao24})` : `비행 중 (${sv.callsign || sv.icao24})`,
                statusText: sv.onGround
                  ? `지상 확인 · ICAO24 ${sv.icao24}`
                  : `고도 ${sv.baroAltitudeM != null ? Math.round(sv.baroAltitudeM) + ' m' : '--'} · ${sv.velocityMs != null ? Math.round(sv.velocityMs * 3.6) + ' km/h' : '--'}`,
                statusCode: sv.onGround ? 'OS_LANDED' : 'OS_AIRBORNE',
                timestampToken: String(sv.lastContact || ''),
                safetyStatus: 'OPENSKY',
                displayTime: sv.lastContact ? new Date(sv.lastContact * 1000).toLocaleString() : '--',
                timestampMs: sv.lastContact ? sv.lastContact * 1000 : null,
                layer: 'air', lat: sv.lat, lon: sv.lon,
                openSkyIcao24: sv.icao24, raw: sv
              };
              const current = state.trackingEventsIntl;
              upsertOpenSkyEvent(current, posEvent);
              const sorted = current.slice().sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
              renderTrackingTimeline(trackingTimelineIntl, sorted);
              if (update.type === 'landed') {
                setTrackingStatus(trackingStatusIntl, `항공기 착륙 확인 (${sv.callsign || sv.icao24}) ✅`, 'success');
              }
            });
          }

          const hubNote = meta.hubs?.length ? ` 경유 ${meta.hubs.join('→')}` : '';
          const routeNote = meta.originCode && meta.destCode
            ? ` · 우편 EDI 경로 ${meta.originCode}→${meta.destCode}${hubNote}` : '';
          const payload = buildTrackingPayload(merged);
          if (trackingLogInputIntl) trackingLogInputIntl.value = payload;
          await runTrackingAnalysisIntl(payload);
          if (routeNote && trackingStatusIntl) {
            trackingStatusIntl.textContent += routeNote;
          }
          return; // handled – skip the default path below
        }
      } catch (_) { /* OpenSky merge failed – fall through to normal render */ }

      // ── Default path: Korea Post events only (original behaviour)
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
  if (trackingDestinationSelect) {
    trackingDestinationSelect.addEventListener('change', () => {
      state.trackingUserDestIso = trackingDestinationSelect.value || 'KR';
      // Re-run analysis with new destination if events are already loaded
      if (state.trackingEventsIntl.length && trackingLogInputIntl) {
        runTrackingAnalysisIntl(trackingLogInputIntl.value).catch(err => console.error(err));
      }
    });
  }
  if (trackingNumberInputIntl) {
    trackingNumberInputIntl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleTrackingFetchIntl();
      }
    });
  }

  // ── OpenSky Network settings (고급 설정 패널) ─────────────────────────
  const openskyModeAnon = document.getElementById('opensky-mode-anon');
  const openskyModeReg  = document.getElementById('opensky-mode-reg');
  const openskyCredentials = document.getElementById('opensky-credentials');
  const openskyUsername = document.getElementById('opensky-username');
  const openskyPassword = document.getElementById('opensky-password');
  const openskySaveBtn  = document.getElementById('opensky-save-btn');
  const openskyBadge    = document.getElementById('opensky-badge');

  function updateOpenSkyBadge() {
    if (!openskyBadge) return;
    if (isOpenSkyAuthenticated()) {
      const { username } = getOpenSkyCredentials();
      openskyBadge.textContent = `🔑 ${username} 계정 사용 중 · 4,000 크레딧/일`;
      openskyBadge.className = 'opensky-badge registered';
    } else {
      openskyBadge.textContent = '🔓 비로그인 · 400 크레딧/일';
      openskyBadge.className = 'opensky-badge anonymous';
    }
  }

  // Restore saved credentials on page load
  const savedCreds = getOpenSkyCredentials();
  if (savedCreds.username && savedCreds.password) {
    if (openskyModeReg) openskyModeReg.checked = true;
    if (openskyCredentials) openskyCredentials.classList.remove('hidden');
    if (openskyUsername) openskyUsername.value = savedCreds.username;
    if (openskyPassword) openskyPassword.value = savedCreds.password;
  } else if (openskyModeAnon) {
    openskyModeAnon.checked = true;
  }
  updateOpenSkyBadge();

  if (openskyModeAnon) {
    openskyModeAnon.addEventListener('change', () => {
      if (openskyCredentials) openskyCredentials.classList.add('hidden');
    });
  }
  if (openskyModeReg) {
    openskyModeReg.addEventListener('change', () => {
      if (openskyCredentials) openskyCredentials.classList.remove('hidden');
      if (openskyUsername) openskyUsername.focus();
    });
  }
  if (openskySaveBtn) {
    openskySaveBtn.addEventListener('click', () => {
      if (openskyModeReg?.checked) {
        const u = (openskyUsername?.value || '').trim();
        const p = openskyPassword?.value || '';
        if (u && p) {
          saveOpenSkyCredentials(u, p);
        } else {
          clearOpenSkyCredentials();
        }
      } else {
        clearOpenSkyCredentials();
        if (openskyUsername) openskyUsername.value = '';
        if (openskyPassword) openskyPassword.value = '';
      }
      updateOpenSkyBadge();
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
