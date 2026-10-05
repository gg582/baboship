/* Web Worker – computes best destinations off the main thread.
 *
 * The worker loads its own WASM instance so heavy computations
 * never block the UI.
 *
 * Protocol
 * --------
 * Main → Worker:
 *   { type: 'init' }                          // load WASM + blob
 *   { type: 'compute', id, originCode, nodes }  // run best-destinations
 *   { type: 'compute_init', nodes }             // send initial node data to worker (for `compute` calls)
 *
 * Worker → Main:
 *   { type: 'init',    ok: bool, error? }
 *   { type: 'result',  id, originCode, data }
 *   { type: 'error',   id, error }
 */

let kernel = null;
let cachedNodes = [];
let cachedNodeByCode = new Map();

const assetBase = new URL('./', self.location.href);
const resolveAsset = (path) => new URL(path, assetBase).href;

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

// Hardcoded route restrictions (mirrors server-side logistics_restrictions)
const ROUTE_RESTRICTIONS = [
  { origin: 'ICN', destination: 'FNJ' },
  { origin: 'FNJ', destination: 'ICN' },
  { origin: 'SVO', destination: 'KBP' },
  { origin: 'KBP', destination: 'SVO' }
];

function getForbiddenCountries(originCode, nodeByCode) { // Changed airportByCode to nodeByCode
  const countries = new Set();
  for (const rule of ROUTE_RESTRICTIONS) {
    if (rule.origin !== originCode) continue;
    const dest = nodeByCode.get(rule.destination); // Changed airportByCode to nodeByCode
    if (dest && dest.country) countries.add(dest.country);
  }
  return countries;
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
  const { default: createNukeKernel } = await import(resolveAsset('wasm/nuke_kernel.js'));
  kernel = await createNukeKernel({
    locateFile: (path) => resolveAsset(`wasm/${path}`)
  });

  kernel.initStore = kernel.cwrap('nuke_wasm_init', 'number', []);
  kernel.searchRoutes = kernel.cwrap('nuke_wasm_search_routes_json', 'string', ['string', 'string', 'number']);
  kernel.loadData = kernel.cwrap('nuke_wasm_load_data', 'number', ['number', 'number']);
  kernel.getDirectDests = kernel.cwrap('nuke_wasm_get_direct_destinations_json', 'string', ['string']);

  kernel.initStore();

  const response = await fetch(resolveAsset('wasm/nuke_blob.bin'));
  if (!response.ok) throw new Error('Failed to fetch data blob');
  const buf = await response.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const ptr = kernel._malloc(u8.length);
  kernel.HEAPU8.set(u8, ptr);
  kernel.loadData(ptr, u8.length);
  kernel._free(ptr);
}

function computeBestDestinations(originCode, nodes, continentFilter) { // Changed airports to nodes
  if (!kernel || !nodes.length) return {};
  const nodeByCode = new Map(nodes.map(n => [n.code, n])); // Changed airportByCode to nodeByCode, a to n
  const origin = nodeByCode.get(originCode); // Changed airportByCode to nodeByCode
  if (!origin) return {};

  const targetContinent = continentFilter || null;
  const originContinent = getContinent(origin.lat, origin.lon);
  const filterContinent = targetContinent || originContinent;
  const originCountry = origin.country || '';
  const forbiddenCountries = getForbiddenCountries(originCode, nodeByCode); // Changed airportByCode to nodeByCode

  // --- Tier 1: Spatial filtering (bounding box 500km / 1000km) ---
  const tier1Near = [];  // within 500km
  const tier1Far = [];   // within 1000km (cross-continent)
  for (const n of nodes) { // Changed a to n, airports to nodes
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

  // --- Tier 2: Hub-to-hub connectivity (direct flights) ---
  const tier2Hubs = [];
  try {
    const directData = JSON.parse(kernel.getDirectDests(originCode));
    const directDests = directData.destinations || [];
    const HUB_MIN_CONNECTIONS = 30;
    for (const d of directDests) {
      if (getContinent(d.lat, d.lon) !== filterContinent) continue;
      // Skip domestic (same-country) destinations
      const destNode = nodeByCode.get(d.code); // Changed destAirport to destNode, airportByCode to nodeByCode
      const destCountry = d.country || destNode?.country || '';
      if (originCountry && destCountry && destCountry === originCountry) continue;
      // Skip destinations in forbidden countries
      if (destCountry && forbiddenCountries.has(destCountry)) continue;
      if (d.connections >= HUB_MIN_CONNECTIONS) {
        if (destNode) tier2Hubs.push(destNode); // Changed destAirport to destNode
      }
    }
  } catch { /* skip */ }

  // --- Merge candidates, deduplicate ---
  const seen = new Set();
  const candidates = [];
  for (const list of [tier1Near, tier2Hubs, tier1Far]) {
    for (const n of list) { // Changed a to n
      if (!seen.has(n.code)) {
        seen.add(n.code);
        candidates.push(n);
      }
    }
  }

  // If too few candidates from tiers, fall back to broader sampling
  if (candidates.length < 20) {
    const remaining = nodes.filter(n => { // Changed airports to nodes, a to n
      if (n.code === originCode || seen.has(n.code)) return false;
      // Skip domestic (same-country) destinations
      if (originCountry && n.country && n.country === originCountry) return false;
      // Skip destinations in forbidden countries
      if (n.country && forbiddenCountries.has(n.country)) return false;
      return getContinent(n.lat, n.lon) === filterContinent;
    });
    for (const n of remaining) { // Changed a to n
      if (!seen.has(n.code)) {
        seen.add(n.code);
        candidates.push(n);
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

    // Skip if we already have a node from this country
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
        route: path.nodes ? path.nodes.map(n => n.code).join(' → ') : originCode + ' → ' + dest.code // Changed airports to nodes, a to n
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

  // New message type to receive initial node data from main thread
  if (msg.type === 'compute_init') {
    cachedNodes = msg.nodes;
    cachedNodeByCode = new Map(cachedNodes.map(n => [n.code, n]));
    return;
  }

  if (msg.type === 'compute') {
    try {
      // Use cached nodes if available
      const nodesToUse = msg.nodes && msg.nodes.length > 0 ? msg.nodes : cachedNodes;
      const data = computeBestDestinations(msg.originCode, nodesToUse, msg.continent || ''); // Changed airports to nodes
      self.postMessage({ type: 'result', id: msg.id, originCode: msg.originCode, data });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, error: err.message });
    }
  }
};
