/* Web Worker – computes best destinations off the main thread.
 *
 * The worker loads its own WASM instance so heavy computations
 * (up to 200 route searches) never block the UI.
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

async function initKernel() {
  const { default: createNukeKernel } = await import('./wasm/nuke_kernel.js');
  kernel = await createNukeKernel({
    locateFile: (path) => `./wasm/${path}`
  });

  kernel.initStore = kernel.cwrap('nuke_wasm_init', 'number', []);
  kernel.searchRoutes = kernel.cwrap('nuke_wasm_search_routes_json', 'string', ['string', 'string', 'number']);
  kernel.loadData = kernel.cwrap('nuke_wasm_load_data', 'number', ['number', 'number']);

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

function computeBestDestinations(originCode, airports) {
  if (!kernel || !airports.length) return {};
  const candidates = airports.filter(a => a.code !== originCode);
  const sample = candidates.length > 200
    ? candidates.filter((_, i) => i % Math.ceil(candidates.length / 200) === 0)
    : candidates;
  const continentResults = {};
  for (const dest of sample) {
    try {
      const result = JSON.parse(kernel.searchRoutes(originCode, dest.code, 2));
      if (!result.paths || !result.paths.length) continue;
      const path = result.paths[0];
      const continent = getContinent(dest.lat, dest.lon);
      if (!continentResults[continent]) continentResults[continent] = [];
      continentResults[continent].push({
        code: dest.code,
        lat: dest.lat,
        lon: dest.lon,
        distanceKm: path.totalDistanceKm,
        efficiency: path.efficiency,
        hops: path.hops || path.legs || 0,
        route: path.airports ? path.airports.map(a => a.code).join(' → ') : originCode + ' → ' + dest.code
      });
    } catch { /* skip */ }
  }
  for (const continent of Object.keys(continentResults)) {
    continentResults[continent].sort((a, b) => b.efficiency - a.efficiency);
    continentResults[continent] = continentResults[continent].slice(0, 3);
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
      const data = computeBestDestinations(msg.originCode, msg.airports);
      self.postMessage({ type: 'result', id: msg.id, originCode: msg.originCode, data });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, error: err.message });
    }
  }
};
