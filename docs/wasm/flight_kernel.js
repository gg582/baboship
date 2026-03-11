/**
 * flight_kernel.js — Pure-JavaScript implementation of the flight kernel API.
 *
 * This module exposes the same interface as the Emscripten-compiled
 * flight_kernel.wasm so that the estimator pipeline works in all environments,
 * including those where the WASM binary has not yet been compiled.
 *
 * When the real WASM is compiled (via `make wasm`) this file is replaced by
 * the Emscripten-generated glue code.  Until then this JS fallback is the
 * active implementation.
 *
 * Exported functions (mirror wasm/flight_kernel.c exported symbols):
 *   fk_init()                               → 1
 *   fk_load_signal_data(jsonString)         → count loaded
 *   fk_generate_candidates(origin, dest)    → JSON string (array)
 *   fk_compute_eta_distribution(candJson)   → JSON string (object)
 */

/* ---- constants ---- */
const FK_MAX_AIRPORTS   = 64;
const FK_MAX_CANDIDATES = 10;
const EARTH_RADIUS_KM   = 6371.0;

/* ---- seed airport database ---- */
const FK_SEED_AIRPORTS = [
  { iata: 'ICN', lat:  37.4691, lon:  126.451, country: 'Korea' },
  { iata: 'GMP', lat:  37.5583, lon:  126.794, country: 'Korea' },
  { iata: 'NRT', lat:  35.7647, lon:  140.386, country: 'Japan' },
  { iata: 'HND', lat:  35.5494, lon:  139.780, country: 'Japan' },
  { iata: 'PVG', lat:  31.1434, lon:  121.805, country: 'China' },
  { iata: 'PEK', lat:  40.0801, lon:  116.584, country: 'China' },
  { iata: 'HKG', lat:  22.3089, lon:  113.915, country: 'Hong Kong' },
  { iata: 'SIN', lat:   1.3502, lon:  103.994, country: 'Singapore' },
  { iata: 'BKK', lat:  13.6811, lon:  100.747, country: 'Thailand' },
  { iata: 'KUL', lat:   2.7456, lon:  101.710, country: 'Malaysia' },
  { iata: 'SGN', lat:  10.8188, lon:  106.652, country: 'Vietnam' },
  { iata: 'DEL', lat:  28.5665, lon:   77.103, country: 'India' },
  { iata: 'BOM', lat:  19.0887, lon:   72.868, country: 'India' },
  { iata: 'DXB', lat:  25.2528, lon:   55.364, country: 'UAE' },
  { iata: 'AUH', lat:  24.4330, lon:   54.651, country: 'UAE' },
  { iata: 'DOH', lat:  25.2608, lon:   51.565, country: 'Qatar' },
  { iata: 'IST', lat:  40.9763, lon:   28.814, country: 'Turkey' },
  { iata: 'FRA', lat:  50.0264, lon:    8.543, country: 'Germany' },
  { iata: 'AMS', lat:  52.3086, lon:    4.764, country: 'Netherlands' },
  { iata: 'LHR', lat:  51.4775, lon:   -0.461, country: 'UK' },
  { iata: 'CDG', lat:  49.0097, lon:    2.548, country: 'France' },
  { iata: 'MXP', lat:  45.6306, lon:    8.728, country: 'Italy' },
  { iata: 'MAD', lat:  40.4936, lon:   -3.567, country: 'Spain' },
  { iata: 'JFK', lat:  40.6398, lon:  -73.779, country: 'USA' },
  { iata: 'ORD', lat:  41.9742, lon:  -87.907, country: 'USA' },
  { iata: 'LAX', lat:  33.9425, lon: -118.408, country: 'USA' },
  { iata: 'MIA', lat:  25.7959, lon:  -80.287, country: 'USA' },
  { iata: 'YYZ', lat:  43.6772, lon:  -79.631, country: 'Canada' },
  { iata: 'GRU', lat: -23.4356, lon:  -46.473, country: 'Brazil' },
  { iata: 'SYD', lat: -33.9461, lon:  151.177, country: 'Australia' },
  { iata: 'MEL', lat: -37.6733, lon:  144.843, country: 'Australia' },
  { iata: 'JNB', lat: -26.1392, lon:   28.246, country: 'South Africa' },
];

/* ---- kernel state ---- */
const _state = {
  initialized: false,
  airports: [],
};

/* ---- utilities ---- */
function _deg2rad(d) { return d * Math.PI / 180; }

function _gcDistanceKm(lat1, lon1, lat2, lon2) {
  const dlat = _deg2rad(lat2 - lat1);
  const dlon = _deg2rad(lon2 - lon1);
  const a = Math.sin(dlat / 2) ** 2 +
            Math.cos(_deg2rad(lat1)) * Math.cos(_deg2rad(lat2)) *
            Math.sin(dlon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _flightHours(distKm) {
  if (distKm <= 0) return 0.5;
  return distKm / 850 + 0.75; /* cruise + overhead */
}

function _normaliseSignal(raw) {
  const v = Math.max(0, Math.min(1, raw));
  return 1 / (1 + Math.exp(-10 * (v - 0.5)));
}

function _findAirport(iata) {
  const code = iata.toUpperCase().slice(0, 3);
  return _state.airports.find(a => a.iata === code) || null;
}

/* ---- delay model (hours) ---- */
const DELAY = {
  originHandling:  { min:  2, max: 12 },
  departureWait:   { min:  1, max:  6 },
  customs:         { min:  2, max: 24 },
  lastMile:        { min:  4, max: 48 },
};

function _delayMode() {
  return Object.values(DELAY).reduce((s, d) => s + (d.min + d.max) / 2, 0);
}
function _delayMin() {
  return Object.values(DELAY).reduce((s, d) => s + d.min, 0);
}
function _delayMax() {
  return Object.values(DELAY).reduce((s, d) => s + d.max, 0);
}

/* ---- exported API ---- */

/**
 * fk_init — initialise kernel with seed airport data.
 * Returns 1 on success.
 */
export function fk_init() {
  if (_state.initialized) return 1;
  _state.airports = FK_SEED_AIRPORTS.map(a => ({ ...a }));
  _state.initialized = true;
  return 1;
}

/**
 * fk_load_signal_data — merge additional airport+signal data.
 * @param {string} json  JSON array of { iata, lat, lon, country, signal? }
 * @returns {number} number of records processed
 */
export function fk_load_signal_data(json) {
  if (!_state.initialized) return 0;
  let records;
  try { records = JSON.parse(json); } catch { return 0; }
  if (!Array.isArray(records)) return 0;
  let count = 0;
  for (const r of records) {
    if (!r.iata) continue;
    const iata = String(r.iata).toUpperCase().slice(0, 3);
    const weight = r.signal != null ? _normaliseSignal(Number(r.signal)) : 1.0;
    const existing = _state.airports.find(a => a.iata === iata);
    const entry = {
      iata,
      lat:     Number(r.lat)     || 0,
      lon:     Number(r.lon)     || 0,
      country: String(r.country || ''),
      weight,
    };
    if (existing) {
      Object.assign(existing, entry);
    } else if (_state.airports.length < FK_MAX_AIRPORTS) {
      _state.airports.push(entry);
    }
    count++;
  }
  return count;
}

/**
 * fk_generate_candidates — generate up to 10 route candidates.
 * @param {string} originIata
 * @param {string} destIata
 * @returns {string} JSON array of candidate objects
 */
export function fk_generate_candidates(originIata, destIata) {
  if (!_state.initialized) return '[]';
  const orig = _findAirport(originIata);
  const dest = _findAirport(destIata);
  if (!orig || !dest) return '[]';

  const candidates = [];

  /* Candidate 0: direct */
  {
    const dist = _gcDistanceKm(orig.lat, orig.lon, dest.lat, dest.lon);
    const flightH = _flightHours(dist);
    candidates.push({
      origin: orig.iata,
      destination: dest.iata,
      hubs: [],
      hubCount: 0,
      segmentDistances: [dist],
      segmentHours: [flightH],
      transferHours: [],
      totalFlightHours: flightH,
      plausibilityScore: 0, /* computed below */
    });
  }

  /* Single-hub candidates */
  const directDist = _gcDistanceKm(orig.lat, orig.lon, dest.lat, dest.lon);
  for (const hub of _state.airports) {
    if (hub.iata === orig.iata || hub.iata === dest.iata) continue;
    const d1 = _gcDistanceKm(orig.lat, orig.lon, hub.lat, hub.lon);
    const d2 = _gcDistanceKm(hub.lat, hub.lon, dest.lat, dest.lon);
    if (d1 + d2 > directDist * 1.35) continue; /* too much detour */
    const segH0 = _flightHours(d1);
    const segH1 = _flightHours(d2);
    const xfer  = 2.5;
    candidates.push({
      origin: orig.iata,
      destination: dest.iata,
      hubs: [hub.iata],
      hubCount: 1,
      segmentDistances: [d1, d2],
      segmentHours: [segH0, segH1],
      transferHours: [xfer],
      totalFlightHours: segH0 + xfer + segH1,
      plausibilityScore: 0,
    });
    if (candidates.length >= FK_MAX_CANDIDATES * 3) break;
  }

  /* Score each candidate */
  for (const c of candidates) {
    const totalDist = c.segmentDistances.reduce((s, v) => s + v, 0);
    const geoScore  = totalDist > 0 ? Math.min(1, directDist / totalDist) : 1;
    const timeScore = Math.max(0, 1 - (c.totalFlightHours - 12) / 72);
    const xferPenalty = Math.max(0.5, 1 - 0.05 * c.hubCount);
    c.plausibilityScore = Math.round(100 * geoScore * timeScore * xferPenalty * 10) / 10;
  }

  /* Sort and take top 10 */
  candidates.sort((a, b) => b.plausibilityScore - a.plausibilityScore);
  const top = candidates.slice(0, FK_MAX_CANDIDATES);

  return JSON.stringify(top);
}

/**
 * fk_compute_eta_distribution — compute probabilistic ETA from candidates JSON.
 * @param {string} candidatesJson
 * @returns {string} JSON with lowerHours, modeHours, upperHours, confidence
 */
export function fk_compute_eta_distribution(candidatesJson) {
  let candidates;
  try { candidates = JSON.parse(candidatesJson); } catch { candidates = []; }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return JSON.stringify({
      lowerHours: 24, modeHours: 72, upperHours: 168, confidence: 0.2,
      delayBreakdown: _buildDelayBreakdown(72),
      candidates: [],
    });
  }

  const delayModeH = _delayMode();
  const delayMinH  = _delayMin();
  const delayMaxH  = _delayMax();

  let weightedSum = 0, weightTotal = 0;
  let minTotal = Infinity, maxTotal = -Infinity;
  const candOut = [];

  for (const c of candidates) {
    const fh    = Number(c.totalFlightHours) || 12;
    const score = Number(c.plausibilityScore) || 50;
    const total = fh + delayModeH;
    const w     = score / 100;
    weightedSum  += total * w;
    weightTotal  += w;
    if (total < minTotal) minTotal = total;
    if (total > maxTotal) maxTotal = total;
    candOut.push({ totalHours: Math.round(total * 10) / 10, score });
  }

  if (weightTotal <= 0) weightTotal = 1;
  const modeH  = weightedSum / weightTotal;
  const lowerH = Math.max(12, minTotal + delayMinH - delayMaxH / 4);
  const upperH = maxTotal + delayMaxH;
  const range  = upperH - lowerH;
  const conf   = Math.max(0.1, Math.min(1, 1 - (range - 24) / (upperH + 1)));

  return JSON.stringify({
    lowerHours:   Math.round(lowerH * 10) / 10,
    modeHours:    Math.round(modeH  * 10) / 10,
    upperHours:   Math.round(upperH * 10) / 10,
    confidence:   Math.round(conf   * 1000) / 1000,
    delayBreakdown: _buildDelayBreakdown(modeH),
    candidates:   candOut,
  });
}

/** Build per-phase breakdown for the visualisation layer. */
function _buildDelayBreakdown(totalModeHours) {
  const flight = Math.max(0, totalModeHours - _delayMode());
  return {
    flightHours:          Math.round(flight * 10) / 10,
    originHandlingHours:  (DELAY.originHandling.min + DELAY.originHandling.max) / 2,
    departureWaitHours:   (DELAY.departureWait.min  + DELAY.departureWait.max)  / 2,
    customsHours:         (DELAY.customs.min        + DELAY.customs.max)        / 2,
    lastMileHours:        (DELAY.lastMile.min        + DELAY.lastMile.max)       / 2,
  };
}

/** Convenience: create a kernel object matching the cwrap-style API used by the estimator. */
export function createFlightKernel() {
  return Promise.resolve({
    fkInit:                 fk_init,
    fkLoadSignalData:       fk_load_signal_data,
    fkGenerateCandidates:   fk_generate_candidates,
    fkComputeEtaDistribution: fk_compute_eta_distribution,
  });
}

export default createFlightKernel;
