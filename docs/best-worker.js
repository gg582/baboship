/* Web Worker – computes best destinations off the main thread.
 *
 * The worker loads its own WASM instance so heavy computations
 * never block the UI.
 *
 * Protocol
 * --------
 * Main → Worker:
 *   { type: 'init' }                          // load WASM + blob
 *   { type: 'compute', id, originCode, airports }  // run best-destinations
 *
 * Worker → Main:
 *   { type: 'init',    ok: bool, error? }
 *   { type: 'result',  id, originCode, data }
 *   { type: 'error',   id, error }
 */

let kernel = null;

function getContinent(lat, lon) {
  if (lat >= 7 && lat <= 84 && lon >= -170 && lon <= -50) return '북미';
  if (lat < 7 && lat >= -60 && lon >= -100 && lon <= -30) return '남미';
  if (lat < -15 && lon >= 100 && lon <= 180) return '오세아니아';
  if (lat >= 35 && lon >= -15 && lon <= 60) return '유럽';
  if (lat < 35 && lat >= -40 && lon >= -20 && lon <= 55) return '아프리카';
  if (lat >= -15 && lon >= 25 && lon <= 55) return '중동';
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

async function initKernel() {
  const { default: createNukeKernel } = await import('./wasm/nuke_kernel.js');
  kernel = await createNukeKernel({
    locateFile: (path) => `./wasm/${path}`
  });

  kernel.initStore = kernel.cwrap('nuke_wasm_init', 'number', []);
  kernel.searchRoutes = kernel.cwrap('nuke_wasm_search_routes_json', 'string', ['string', 'string', 'number']);
  kernel.loadData = kernel.cwrap('nuke_wasm_load_data', 'number', ['number', 'number']);
  kernel.getDirectDests = kernel.cwrap('nuke_wasm_get_direct_destinations_json', 'string', ['string']);

  kernel.initStore();

  const response = await fetch('./wasm/nuke_blob.bin');
  if (!response.ok) throw new Error('Failed to fetch data blob');
  const buf = await response.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const ptr = kernel._malloc(u8.length);
  kernel.HEAPU8.set(u8, ptr);
  kernel.loadData(ptr, u8.length);
  kernel._free(ptr);
}

function computeBestDestinations(originCode, airports, continentFilter) {
  if (!kernel || !airports.length) return {};
  const airportByCode = new Map(airports.map(a => [a.code, a]));
  const origin = airportByCode.get(originCode);
  if (!origin) return {};

  const targetContinent = continentFilter || null;
  const originContinent = getContinent(origin.lat, origin.lon);
  const filterContinent = targetContinent || originContinent;
  const originCountry = origin.country || '';

  // --- Tier 1: Spatial filtering (bounding box 500km / 1000km) ---
  const tier1Near = [];  // within 500km
  const tier1Far = [];   // within 1000km (cross-continent)
  for (const a of airports) {
    if (a.code === originCode) continue;
    if (getContinent(a.lat, a.lon) !== filterContinent) continue;
    // Skip domestic (same-country) destinations
    if (originCountry && a.country && a.country === originCountry) continue;
    const dist = haversineKm(origin.lat, origin.lon, a.lat, a.lon);
    if (dist <= 500) tier1Near.push(a);
    else if (dist <= 1000) tier1Far.push(a);
  }

  // --- Tier 2: Hub-to-hub connectivity (direct flights) ---
  const tier2Hubs = [];
  try {
    const directData = JSON.parse(kernel.getDirectDests(originCode));
    const directDests = directData.destinations || [];
    const HUB_MIN_CONNECTIONS = 30;
    for (const d of directDests) {
      if (getContinent(d.lat, d.lon) !== filterContinent) continue;
      // Skip domestic (same-country) destinations
      const destAirport = d.country ? null : airportByCode.get(d.code);
      const destCountry = d.country || destAirport?.country || '';
      if (originCountry && destCountry && destCountry === originCountry) continue;
      if (d.connections >= HUB_MIN_CONNECTIONS) {
        const existing = destAirport || airportByCode.get(d.code);
        if (existing) tier2Hubs.push(existing);
      }
    }
  } catch { /* skip */ }

  // --- Merge candidates, deduplicate ---
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

  // If too few candidates from tiers, fall back to broader sampling
  if (candidates.length < 20) {
    const remaining = airports.filter(a => {
      if (a.code === originCode || seen.has(a.code)) return false;
      // Skip domestic (same-country) destinations
      if (originCountry && a.country && a.country === originCountry) return false;
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

  // Cap at 200 for performance
  const sample = candidates.length > 200
    ? candidates.slice(0, 200)
    : candidates;

  // --- Search routes and score ---
  const seenCountries = new Set();
  const continentResults = {};
  const MAX_COUNTRIES = 5;

  for (const dest of sample) {
    // Early return: stop if we already have 5 distinct countries
    if (seenCountries.size >= MAX_COUNTRIES) break;

    const destCountry = dest.country || '';

    // Skip domestic (same-country) destinations
    if (originCountry && destCountry && destCountry === originCountry) continue;

    // Skip if we already have an airport from this country
    if (destCountry && seenCountries.has(destCountry)) continue;

    try {
      const result = JSON.parse(kernel.searchRoutes(originCode, dest.code, 2));
      if (!result.paths || !result.paths.length) continue;
      const path = result.paths[0];
      const dist = path.totalDistanceKm;
      const efficiency = path.efficiency;

      // Weighted score: reliability / (distance + 1) * 1000
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

  // Sort by weighted score (descending) and keep top 5 with unique countries
  for (const continent of Object.keys(continentResults)) {
    continentResults[continent].sort((a, b) => b.score - a.score);

    // Deduplicate by country within each continent
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

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      await initKernel();
      self.postMessage({ type: 'init', ok: true });
    } catch (err) {
      self.postMessage({ type: 'init', ok: false, error: err.message });
    }
    return;
  }

  if (msg.type === 'compute') {
    try {
      const data = computeBestDestinations(msg.originCode, msg.airports, msg.continent || '');
      self.postMessage({ type: 'result', id: msg.id, originCode: msg.originCode, data });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, error: err.message });
    }
  }
};
