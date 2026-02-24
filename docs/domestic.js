const state = {
  nodes: [],
  nodeMap: new Map(),
  selection: { from: null, to: null },
  activeField: 'from',
  domesticTrackingEvents: [],
  wasmUnavailableReason: '',
  kernel: null
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
      'circle-radius': 5,
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
  ORS_ROUTE_LINE: {
    id: 'ors-route-line',
    type: 'line',
    source: 'ors-route',
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': '#FF8C00',
      'line-width': 3,
      'line-opacity': 0.8
    }
  }
};

const trackerConfig = window.__baboship_config || {};
const TRACKER_DELIVERY_API = trackerConfig.trackerApiBase || 'https://apis.tracker.delivery';
const TRACKER_API_KEY = trackerConfig.trackerApiKey || '';
const ORS_API_KEY = trackerConfig.orsApiKey || '';
const ORS_BASE_URL = 'https://api.openrouteservice.org/v2/directions/driving-car';

async function fetchJsonOrError(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let parsed = null;
  if (raw) {
    try { parsed = JSON.parse(raw); } catch (err) { if (response.ok) throw new Error('JSON 파싱 실패'); }
  }
  if (!response.ok) {
    const detail = (parsed && parsed.error) || (raw ? raw.trim() : '');
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return parsed ?? {};
}

async function fetchORSPath(originCoords, destCoords) {
  if (!ORS_API_KEY) return null;
  const url = `${ORS_BASE_URL}?api_key=${ORS_API_KEY}&start=${originCoords.lon},${originCoords.lat}&end=${destCoords.lon},${destCoords.lat}`;
  try {
    const data = await fetchJsonOrError(url);
    if (data.features && data.features.length > 0) {
      return {
        geojson: data.features[0].geometry,
        distance: data.features[0].properties.summary.distance
      };
    }
  } catch (err) { console.error('Failed to fetch ORS path:', err); }
  return null;
}

function initMap(containerId) {
  const map = new maplibregl.Map({
    container: containerId,
    style: 'https://tiles.stadiamaps.com/styles/stadium-dark.json',
    center: [127.5, 36.5], // Center on Korea
    zoom: 7
  });

  map.on('load', () => {
    map.addSource('nodes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('ors-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer(MapLayerStyle.ORS_ROUTE_LINE);
    map.addLayer(MapLayerStyle.NODE_CIRCLE);
    map.addLayer(MapLayerStyle.NODE_SYMBOL);
    fetchNodes();
  });
  return map;
}

async function fetchNodes() {
    const loader = document.getElementById('map-loader');
    try {
        // In domestic mode, we might just fetch from the server or use predefined hubs
        const data = await fetchJsonOrError('./nodes?limit=100'); // Limit to 100 for domestic view
        state.nodes = data.nodes || [];
        state.nodeMap = new Map(state.nodes.map(n => [n.code, n]));
        updateMapNodes(mainMapLibre);
        if (loader) loader.style.display = 'none';
    } catch (err) {
        if (loader) loader.textContent = '데이터 로드 실패: ' + err.message;
    }
}

function updateMapNodes(mapInstance) {
  if (!mapInstance || !mapInstance.getSource('nodes')) return;
  const features = state.nodes.map(node => ({
    type: 'Feature',
    properties: { code: node.code, name: node.name, layer: node.layer },
    geometry: { type: 'Point', coordinates: [node.lon, node.lat] }
  }));
  mapInstance.getSource('nodes').setData({ type: 'FeatureCollection', features });
}

function updateORSMapRoute(mapInstance, orsGeojson) {
  if (!mapInstance || !mapInstance.getSource('ors-route')) return;
  mapInstance.getSource('ors-route').setData({
    type: 'FeatureCollection',
    features: orsGeojson ? [{ type: 'Feature', geometry: orsGeojson }] : []
  });
}

function setTrackingStatus(element, message, variant = 'info') {
  if (!element) return;
  element.textContent = message;
  element.classList.remove('error', 'success');
  if (variant === 'error') element.classList.add('error');
  if (variant === 'success') element.classList.add('success');
}

function verifyMod7Js(trackNo) {
  const len = trackNo.length;
  if (len < 10) return false;
  let mainPart = 0;
  for (let i = 0; i < len - 1; i++) mainPart = (mainPart * 10) + parseInt(trackNo[i], 10);
  return (mainPart % 7) === parseInt(trackNo[len - 1], 10);
}

function resolveDomesticCarriers(trackNo) {
  const normalized = (trackNo || '').trim().replace(/[^0-9]/g, '');
  const carriers = [];
  const pushUnique = (id, label) => { if (!carriers.some(entry => entry.id === id)) carriers.push({ id, label }); };
  if (normalized.length === 13 && /^[1256]/.test(normalized)) { pushUnique('kr.epost', '우체국택배'); return carriers; }
  if (normalized.length === 11 && verifyMod7Js(normalized)) { pushUnique('kr.logen', '로젠택배'); return carriers; }
  if ((normalized.length === 10 || normalized.length === 12) && verifyMod7Js(normalized)) {
    pushUnique('kr.cjlogistics', 'CJ대한통운');
    pushUnique('kr.hanjin', '한진택배');
  }
  return carriers;
}

function enrichTrackingEvents(rawEvents) {
  return (rawEvents || []).map(p => {
    const loc = p?.location?.name || p?.officeName || '';
    const date = p?.time ? new Date(p.time) : null;
    return {
      displayTime: date ? date.toLocaleString() : '--',
      locationName: loc,
      statusText: p?.status?.text || p?.description || '',
      lat: p?.location?.lat,
      lon: p?.location?.lon
    };
  });
}

async function handleDomesticTrackingFetch() {
  const input = document.getElementById('tracking-number-domestic');
  const carrierSelect = document.getElementById('carrier-select-domestic');
  const statusEl = document.getElementById('tracking-status-domestic');
  const timelineEl = document.getElementById('tracking-timeline-domestic');
  const metricsEl = document.getElementById('tracking-metrics-domestic');
  const logInput = document.getElementById('tracking-log-input-domestic');

  const invoice = input.value.trim();
  if (!invoice) { setTrackingStatus(statusEl, '송장번호를 입력하세요.', 'error'); return; }

  let carrierId = carrierSelect.value;
  if (!carrierId) {
    const detected = resolveDomesticCarriers(invoice);
    if (detected.length === 1) { carrierId = detected[0].id; carrierSelect.value = carrierId; }
    else if (detected.length > 1) { setTrackingStatus(statusEl, '택배사를 선택해 주세요.', 'info'); return; }
    else { setTrackingStatus(statusEl, '택배사 자동 감지 불가. 직접 선택하세요.', 'error'); return; }
  }

  setTrackingStatus(statusEl, '조회 중...');
  try {
    const endpoint = `${TRACKER_DELIVERY_API}/carriers/${carrierId}/tracks/${encodeURIComponent(invoice)}`;
    const data = await fetchJsonOrError(endpoint, { headers: TRACKER_API_KEY ? { 'X-Tracker-API-Key': TRACKER_API_KEY } : {} });
    if (logInput) logInput.value = JSON.stringify(data, null, 2);

    const enriched = enrichTrackingEvents(data.progresses);
    timelineEl.innerHTML = enriched.map(e => `<div class="timeline-item"><div>${e.displayTime}</div><div><strong>${e.locationName}</strong>: ${e.statusText}</div></div>`).join('');

    metricsEl.innerHTML = `
      <div class="metric"><span>보내는 분</span><strong>${data.from?.name || '--'}</strong></div>
      <div class="metric"><span>받는 분</span><strong>${data.to?.name || '--'}</strong></div>
      <div class="metric"><span>현재 상태</span><strong>${data.state?.text || '--'}</strong></div>
    `;

    const validCoords = enriched.filter(e => e.lat && e.lon);
    if (validCoords.length >= 2) {
      const start = validCoords[0];
      const end = validCoords[validCoords.length - 1];
      const route = await fetchORSPath({ lat: start.lat, lon: start.lon }, { lat: end.lat, lon: end.lon });
      if (route) {
        updateORSMapRoute(mainMapLibre, route.geojson);
        metricsEl.innerHTML += `<div class="metric"><span>도로 최단거리</span><strong>${(route.distance / 1000).toFixed(1)} km</strong></div>`;
      }
    }
    setTrackingStatus(statusEl, '조회 완료', 'success');
  } catch (err) {
    setTrackingStatus(statusEl, err.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  mainMapLibre = initMap('map-container');
  document.getElementById('tracking-fetch-btn-domestic').addEventListener('click', handleDomesticTrackingFetch);
  
  // Tab switching
  document.querySelectorAll('[data-mode-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.modeTab;
      document.querySelectorAll('[data-mode-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('[data-panel]').forEach(p => p.classList.add('hidden'));
      document.getElementById(`${mode}-panel`).classList.remove('hidden');
      if (mainMapLibre) mainMapLibre.resize();
    });
  });
});
