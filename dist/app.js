const state = {
  airports: [],
  airportMap: new Map(),
  routes: [],
  activeField: 'from',
  selection: { from: null, to: null },
  best: [],
  kernel: null
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
      state.kernel = null;
      return;
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
    // cwrap could not resolve it.
    if (typeof state.kernel.initStore !== 'function') {
      if (typeof state.kernel._nuke_wasm_init === 'function') {
        state.kernel.initStore = state.kernel._nuke_wasm_init;
      } else {
        console.error('initStore is not a function - symbol might be missing in WASM exports');
        state.kernel = null;
        return;
      }
    }

    state.kernel.initStore();

    // Load main routes/graph blob
    const response = await fetch('./wasm/nuke_blob.bin');
    if (response.ok) {
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
      }
    }

    console.log('WASM Kernel initialized');
  } catch (err) {
    console.warn('WASM Kernel failed to load:', err);
    state.kernel = null;
  }
}

// Service Worker Registration for WASM Server
async function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('sw.js', {
        scope: './',
        type: 'module'
      });
      console.log('Service Worker registered with scope:', registration.scope);
      
      // Wait for SW to be ready
      await navigator.serviceWorker.ready;
      
      // Refresh data after SW is active
      fetchBest();
      fetchHealth();
    } catch (err) {
      console.error('Service Worker registration failed:', err);
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
  initWasm();
  initServiceWorker();

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
  const bestFromSection = document.getElementById('best-from-section');
  const bestToSection = document.getElementById('best-to-section');
  const bestFromTitle = document.getElementById('best-from-title');
  const bestToTitle = document.getElementById('best-to-title');
  const bestFromResults = document.getElementById('best-from-results');
  const bestToResults = document.getElementById('best-to-results');
  const bestRefreshBtn = document.getElementById('best-refresh-btn');
  const mapModal = document.getElementById('map-modal');
  const modalCanvas = document.getElementById('route-map-large');
  const modalCloseBtn = document.getElementById('map-modal-close');

  const projectPoint = (lon, lat) => ({ u: (lon + 180) / 360, v: (90 - lat) / 180 });
  const view = {
    zoom: 1,
    minZoom: 1,
    maxZoom: 5,
    centerX: 0.5,
    centerY: 0.5
  };
  let statusBeforeModal = '';
  const dragState = {
    active: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    moved: false,
    blockClick: false
  };
  const modalHintMessage = '크게보기 모드: 드래그로 이동하고 클릭해서 공항을 지정하세요. X 버튼으로 닫습니다.';
  const mapCanvases = new Map();

  function registerCanvas(key, element) {
    if (!element) {
      return;
    }
    mapCanvases.set(key, { canvas: element, ctx: element.getContext('2d') });
  }

  registerCanvas('main', mainCanvas);
  registerCanvas('modal', modalCanvas);

  function getViewWindow() {
    const width = 1 / view.zoom;
    const height = 1 / view.zoom;
    const left = view.centerX - width / 2;
    const top = view.centerY - height / 2;
    return { left, top, width, height };
  }

  function clampViewCenter() {
    const width = 1 / view.zoom;
    const height = 1 / view.zoom;
    const halfW = width / 2;
    const halfH = height / 2;
    if (width >= 1) {
      view.centerX = 0.5;
    } else {
      view.centerX = Math.min(Math.max(view.centerX, halfW), 1 - halfW);
    }
    if (height >= 1) {
      view.centerY = 0.5;
    } else {
      view.centerY = Math.min(Math.max(view.centerY, halfH), 1 - halfH);
    }
  }

  function worldToCanvas(u, v, viewport, targetCanvas) {
    const x = ((u - viewport.left) / viewport.width) * targetCanvas.width;
    const y = ((v - viewport.top) / viewport.height) * targetCanvas.height;
    return { x, y };
  }

  function canvasToWorld(normX, normY, viewport) {
    return {
      u: viewport.left + normX * viewport.width,
      v: viewport.top + normY * viewport.height
    };
  }

  function resizeCanvasTarget(target) {
    if (!target || !target.canvas) {
      return;
    }
    const canvasEl = target.canvas;
    const rect = canvasEl.getBoundingClientRect();
    const parentRect = canvasEl.parentElement ? canvasEl.parentElement.getBoundingClientRect() : rect;
    const width = Math.max(canvasEl.clientWidth || rect.width || parentRect.width || 0, 320);
    const height = Math.max(canvasEl.clientHeight || rect.height || parentRect.height || 0, 320);
    if (canvasEl.width !== width || canvasEl.height !== height) {
      canvasEl.width = width;
      canvasEl.height = height;
    }
  }

  function resizeAllCanvases() {
    mapCanvases.forEach(resizeCanvasTarget);
    drawAllScenes();
  }

  function drawBackground(viewport, target) {
    const { ctx, canvas: canvasEl } = target;
    const w = canvasEl.width;
    const h = canvasEl.height;
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, '#02142f');
    gradient.addColorStop(1, '#030712');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.lineWidth = 1;
    for (let lon = -120; lon <= 120; lon += 60) {
      const worldX = (lon + 180) / 360;
      if (worldX < viewport.left || worldX > viewport.left + viewport.width) {
        continue;
      }
      const top = worldToCanvas(worldX, viewport.top, viewport, canvasEl);
      const bottom = worldToCanvas(worldX, viewport.top + viewport.height, viewport, canvasEl);
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bottom.x, bottom.y);
      ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const worldY = (90 - lat) / 180;
      if (worldY < viewport.top || worldY > viewport.top + viewport.height) {
        continue;
      }
      const left = worldToCanvas(viewport.left, worldY, viewport, canvasEl);
      const right = worldToCanvas(viewport.left + viewport.width, worldY, viewport, canvasEl);
      ctx.beginPath();
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
    }
  }

  function drawContinents(viewport, target) {
    const { ctx, canvas: canvasEl } = target;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.strokeStyle = 'rgba(110,231,255,0.2)';
    ctx.lineWidth = 1.2;
    continentShapes.forEach(shape => {
      ctx.beginPath();
      shape.forEach(([lon, lat], idx) => {
        const point = projectPoint(lon, lat);
        const { x, y } = worldToCanvas(point.u, point.v, viewport, canvasEl);
        if (idx === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });
  }

  function drawAirports(viewport, target) {
    const { ctx, canvas: canvasEl } = target;
    state.airports.forEach(airport => {
      const { x, y } = worldToCanvas(airport.u, airport.v, viewport, canvasEl);
      const isSelected =
        (state.selection.from && state.selection.from.code === airport.code) ||
        (state.selection.to && state.selection.to.code === airport.code);
      const radius = isSelected ? 4 : 2;
      ctx.beginPath();
      ctx.fillStyle = isSelected ? '#fbbf24' : 'rgba(148,163,184,0.55)';
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawRoutes(viewport, target) {
    const { ctx, canvas: canvasEl } = target;
    if (!state.routes.length) {
      return;
    }
    ctx.save();
    ctx.lineWidth = 2;
    state.routes.forEach((route, idx) => {
      const stops = route.airports.map(a => state.airportMap.get(a.code)).filter(Boolean);
      if (stops.length < 2) {
        return;
      }
      ctx.beginPath();
      ctx.strokeStyle = idx === 0 ? 'rgba(34,211,238,0.9)' : 'rgba(94,234,212,0.6)';
      stops.forEach((airport, i) => {
        const { x, y } = worldToCanvas(airport.u, airport.v, viewport, canvasEl);
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    });
    ctx.restore();
  }

  function drawSceneOnTarget(target) {
    if (!target || !target.ctx || !target.canvas) {
      return;
    }
    const { ctx, canvas: canvasEl } = target;
    if (!canvasEl.width || !canvasEl.height) {
      return;
    }
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    const viewport = getViewWindow();
    drawBackground(viewport, target);
    drawContinents(viewport, target);
    drawRoutes(viewport, target);
    drawAirports(viewport, target);
  }

  function drawAllScenes() {
    mapCanvases.forEach(drawSceneOnTarget);
  }

  function updateSelectionLabels() {
    selectionFrom.textContent = state.selection.from ? state.selection.from.code : '--';
    selectionTo.textContent = state.selection.to ? state.selection.to.code : '--';
  }

  function setActiveField(field) {
    state.activeField = field;
    modeButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.field === field));
    statusEl.textContent = '다음 클릭은 ' + (field === 'from' ? '출발' : '도착') + ' 공항을 설정합니다.';
  }

  function setInputField(field, value) {
    const target = field === 'from' ? fromInput : toInput;
    const cleaned = (value || '').trim().toUpperCase();
    target.value = cleaned;
    const airport = state.airportMap.get(cleaned) || null;
    state.selection[field] = airport;
    updateSelectionLabels();
    drawAllScenes();
    refreshBestSections();
  }

  function nearestAirport(lat, lon) {
    let best = null;
    let bestScore = Infinity;
    state.airports.forEach(airport => {
      const dLat = airport.lat - lat;
      const dLon = airport.lon - lon;
      const score = dLat * dLat + dLon * dLon;
      if (score < bestScore) {
        best = airport;
        bestScore = score;
      }
    });
    return best;
  }

  function handleCanvasClick(evt) {
    if (dragState.blockClick) {
      dragState.blockClick = false;
      return;
    }
    const canvasEl = evt.currentTarget;
    const rect = canvasEl.getBoundingClientRect();
    const normX = (evt.clientX - rect.left) / rect.width;
    const normY = (evt.clientY - rect.top) / rect.height;
    const viewport = getViewWindow();
    const world = canvasToWorld(normX, normY, viewport);
    const lon = world.u * 360 - 180;
    const lat = 90 - world.v * 180;
    const match = nearestAirport(lat, lon);
    if (match) {
      setInputField(state.activeField, match.code);
    }
  }

  function handleCanvasWheel(evt) {
    evt.preventDefault();
    const canvasEl = evt.currentTarget;
    const delta = evt.deltaY;
    const factor = delta < 0 ? 1.15 : 0.85;
    const newZoom = Math.max(view.minZoom, Math.min(view.maxZoom, view.zoom * factor));
    if (newZoom === view.zoom) {
      return;
    }
    const rect = canvasEl.getBoundingClientRect();
    const normX = (evt.clientX - rect.left) / rect.width;
    const normY = (evt.clientY - rect.top) / rect.height;
    const viewport = getViewWindow();
    const focus = canvasToWorld(normX, normY, viewport);
    const newWidth = 1 / newZoom;
    const newHeight = 1 / newZoom;
    let newLeft = focus.u - normX * newWidth;
    let newTop = focus.v - normY * newHeight;
    const maxLeft = Math.max(0, 1 - newWidth);
    const maxTop = Math.max(0, 1 - newHeight);
    newLeft = Math.min(Math.max(newLeft, 0), maxLeft);
    newTop = Math.min(Math.max(newTop, 0), maxTop);
    view.centerX = newLeft + newWidth / 2;
    view.centerY = newTop + newHeight / 2;
    view.zoom = newZoom;
    clampViewCenter();
    drawAllScenes();
  }

  function handlePointerDown(evt) {
    evt.preventDefault();
    const canvasEl = evt.currentTarget;
    dragState.active = true;
    dragState.pointerId = evt.pointerId;
    dragState.lastX = evt.clientX;
    dragState.lastY = evt.clientY;
    dragState.moved = false;
    dragState.blockClick = false;
    if (canvasEl.setPointerCapture) {
      canvasEl.setPointerCapture(evt.pointerId);
    }
    canvasEl.classList.add('dragging');
  }

  function handlePointerMove(evt) {
    if (!dragState.active || dragState.pointerId !== evt.pointerId) {
      return;
    }
    const canvasEl = evt.currentTarget;
    const dx = evt.clientX - dragState.lastX;
    const dy = evt.clientY - dragState.lastY;
    if (dx === 0 && dy === 0) {
      return;
    }
    const viewport = getViewWindow();
    const worldDx = (dx / canvasEl.width) * viewport.width;
    const worldDy = (dy / canvasEl.height) * viewport.height;
    view.centerX -= worldDx;
    view.centerY -= worldDy;
    clampViewCenter();
    dragState.lastX = evt.clientX;
    dragState.lastY = evt.clientY;
    dragState.moved = true;
    dragState.blockClick = true;
    drawAllScenes();
  }

  function handlePointerUp(evt) {
    if (!dragState.active || dragState.pointerId !== evt.pointerId) {
      return;
    }
    dragState.active = false;
    const canvasEl = evt.currentTarget;
    canvasEl.classList.remove('dragging');
    if (canvasEl.releasePointerCapture) {
      if (!canvasEl.hasPointerCapture || canvasEl.hasPointerCapture(evt.pointerId)) {
        canvasEl.releasePointerCapture(evt.pointerId);
      }
    }
    if (!dragState.moved) {
      dragState.blockClick = false;
    }
    dragState.pointerId = null;
    dragState.moved = false;
  }

  function openLargeMode(evt) {
    if (evt) {
      evt.preventDefault();
    }
    if (!mapModal || mapModal.classList.contains('open')) {
      return;
    }
    mapModal.classList.add('open');
    mapModal.setAttribute('aria-hidden', 'false');
    statusBeforeModal = statusEl.textContent;
    statusEl.textContent = modalHintMessage;
    requestAnimationFrame(() => {
      const modalTarget = mapCanvases.get('modal');
      if (modalTarget) {
        resizeCanvasTarget(modalTarget);
      }
      drawAllScenes();
    });
  }

  function closeLargeMode() {
    if (!mapModal || !mapModal.classList.contains('open')) {
      return;
    }
    mapModal.classList.remove('open');
    mapModal.setAttribute('aria-hidden', 'true');
    if (statusEl.textContent === modalHintMessage) {
      statusEl.textContent = statusBeforeModal || '지도를 클릭하거나 공항 코드를 입력하세요.';
    }
    statusBeforeModal = '';
    dragState.blockClick = false;
  }

  function attachCanvasEvents(canvasEl) {
    if (!canvasEl) {
      return;
    }
    canvasEl.addEventListener('click', handleCanvasClick);
    canvasEl.addEventListener('wheel', handleCanvasWheel, { passive: false });
    canvasEl.addEventListener('pointerdown', handlePointerDown);
    canvasEl.addEventListener('pointermove', handlePointerMove);
    canvasEl.addEventListener('pointerup', handlePointerUp);
    canvasEl.addEventListener('pointercancel', handlePointerUp);
    canvasEl.addEventListener('pointerleave', handlePointerUp);
  }

  function renderResults(data) {
    resultsEl.innerHTML = '';
    if (!data || !data.paths || !data.paths.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '조건에 맞는 경로가 없습니다. 공항을 다시 선택하세요.';
      resultsEl.appendChild(empty);
      state.routes = [];
      drawAllScenes();
      return;
    }
    state.routes = data.paths;
    data.paths.forEach((path, idx) => {
      const card = document.createElement('article');
      card.className = 'result-card';
      const title = document.createElement('h3');
      title.textContent = '경로 ' + (idx + 1) + ': ' + path.airports.map(a => a.code).join(' → ');
      card.appendChild(title);
      const details = document.createElement('p');
      details.textContent = path.legs + ' 구간 · ' + path.hops + ' 연결 · ' + path.totalDistanceKm.toFixed(1) + ' km';
      card.appendChild(details);
      const tags = document.createElement('div');
      tags.className = 'route-tags';
      const eff = document.createElement('span');
      eff.className = 'tag accent';
      eff.textContent = '효율 ' + path.efficiency.toFixed(3);
      tags.appendChild(eff);
      const gc = document.createElement('span');
      gc.className = 'tag';
      gc.textContent = '대권거리 ' + path.greatCircleKm.toFixed(1) + ' km';
      tags.appendChild(gc);
      card.appendChild(tags);
      resultsEl.appendChild(card);
    });
    drawAllScenes();
  }

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

  function computeBestDestinations(originCode) {
    if (!state.kernel || state.airports.length === 0) return {};
    const origin = state.airportMap.get(originCode);
    if (!origin) return {};
    const candidates = state.airports.filter(a => a.code !== originCode);
    const sample = candidates.length > 200
      ? candidates.filter((_, i) => i % Math.ceil(candidates.length / 200) === 0)
      : candidates;
    const continentResults = {};
    for (const dest of sample) {
      try {
        const result = JSON.parse(state.kernel.searchRoutes(originCode, dest.code, 2));
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

  async function refreshBestSections() {
    const fromCode = fromInput.value.trim().toUpperCase();
    const toCode = toInput.value.trim().toUpperCase();
    if (fromCode.length === 3 && state.airportMap.has(fromCode)) {
      bestFromSection.style.display = '';
      bestFromTitle.textContent = fromCode + '에서 최적 목적지';
      bestFromResults.classList.add('loading');
      await new Promise(r => setTimeout(r, 30));
      const fromData = computeBestDestinations(fromCode);
      renderBestDestinations(bestFromResults, fromData);
      bestFromResults.classList.remove('loading');
    } else {
      bestFromSection.style.display = 'none';
    }
    if (toCode.length === 3 && state.airportMap.has(toCode)) {
      bestToSection.style.display = '';
      bestToTitle.textContent = toCode + '에서 최적 목적지';
      bestToResults.classList.add('loading');
      await new Promise(r => setTimeout(r, 30));
      const toData = computeBestDestinations(toCode);
      renderBestDestinations(bestToResults, toData);
      bestToResults.classList.remove('loading');
    } else {
      bestToSection.style.display = 'none';
    }
  }

  async function fetchAirports() {
    const batchSize = 1024;
    const combined = [];
    let offset = 0;
    let total = null;
    loader.classList.remove('error');
    loader.style.display = 'flex';
    loader.textContent = '공항 데이터를 불러오는 중...';
    try {
      while (true) {
        const params = new URLSearchParams({
          limit: String(batchSize),
          offset: String(offset)
        });
        const res = await fetch('./airports?' + params.toString());
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || '공항 데이터를 불러오지 못했습니다.');
        }
        if (total === null && typeof data.total === 'number') {
          total = data.total;
        }
        const chunk = Array.isArray(data.airports) ? data.airports : [];
        chunk.forEach(a => {
          const point = projectPoint(a.lon, a.lat);
          combined.push({ id: a.id, code: a.code, lat: a.lat, lon: a.lon, u: point.u, v: point.v });
        });
        offset += chunk.length;
        if (total) {
          const loaded = Math.min(offset, total);
          loader.textContent = '공항 데이터를 불러오는 중... (' + loaded.toLocaleString() + ')';
        }
        if (!chunk.length || chunk.length < batchSize || (total && offset >= total)) {
          break;
        }
      }
      if (!combined.length) {
        loader.classList.add('error');
        loader.textContent = '공항 데이터가 비어 있습니다.';
        statusEl.textContent = '공항 데이터가 비어 있습니다. 데이터를 다시 적재해 주세요.';
        return;
      }
      state.airports = combined;
      state.airportMap = new Map();
      state.airports.forEach(a => state.airportMap.set(a.code, a));
      const totalCount = total || state.airports.length;
      statAirports.textContent = totalCount.toLocaleString();
      loader.style.display = 'none';
      drawAllScenes();
      if (fromInput.value.trim()) {
        setInputField('from', fromInput.value);
      }
      if (toInput.value.trim()) {
        setInputField('to', toInput.value);
      }
    } catch (err) {
      loader.classList.add('error');
      loader.textContent = '공항 데이터를 불러오지 못했습니다.';
      statusEl.textContent = err && err.message
        ? err.message
        : '공항 데이터를 불러오지 못했습니다. 새로고침 해주세요.';
    }
  }

  function fetchHealth() {
    fetch('./health')
      .then(res => res.json())
      .then(data => {
        statRoutes.textContent = (data.routes_loaded || 0).toLocaleString();
        statWorkers.textContent = String(data.worker_threads || 0);
      })
      .catch(() => {});
  }

  function searchRoutes() {
    const from = fromInput.value.trim().toUpperCase();
    const to = toInput.value.trim().toUpperCase();
    if (from.length !== 3 || to.length !== 3) {
      statusEl.textContent = '3자리 IATA 코드를 모두 입력해 주세요.';
      return;
    }
    const params = new URLSearchParams({
      from,
      to,
      maxTransfers: transfersInput.value || '3',
      maxResults: resultsInput.value || '8'
    });
    statusEl.textContent = '가능한 경로를 계산하는 중입니다...';
    fetch('./routes?' + params.toString())
      .then(async res => {
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || '검색이 차단되었습니다.');
        }
        return data;
      })
      .then(data => {
        statRoutes.textContent = String(data.results || 0);
        renderResults(data);
        statusEl.textContent = String(data.results || 0) + '개의 후보가 계산되었습니다.';
      })
      .catch(err => {
        statusEl.textContent = err.message || '검색 중 문제가 발생했습니다.';
      });
  }

  function fetchBest() {
    refreshBestSections();
  }

  swapBtn.addEventListener('click', () => {
    const from = fromInput.value.trim().toUpperCase();
    const to = toInput.value.trim().toUpperCase();
    setInputField('from', to);
    setInputField('to', from);
  });

  modeButtons.forEach(btn => btn.addEventListener('click', () => setActiveField(btn.dataset.field)));
  fromInput.addEventListener('focus', () => setActiveField('from'));
  toInput.addEventListener('focus', () => setActiveField('to'));
  fromInput.addEventListener('change', () => setInputField('from', fromInput.value));
  toInput.addEventListener('change', () => setInputField('to', toInput.value));
  attachCanvasEvents(mainCanvas);
  attachCanvasEvents(modalCanvas);
  if (mainCanvas) {
    mainCanvas.addEventListener('contextmenu', openLargeMode);
  }
  if (modalCanvas) {
    modalCanvas.addEventListener('contextmenu', evt => evt.preventDefault());
  }
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closeLargeMode);
  }
  if (mapModal) {
    mapModal.addEventListener('click', evt => {
      if (evt.target === mapModal) {
        closeLargeMode();
      }
    });
  }
  document.addEventListener('keydown', evt => {
    if (evt.key === 'Escape') {
      closeLargeMode();
    }
  });
  searchBtn.addEventListener('click', searchRoutes);
  window.addEventListener('resize', resizeAllCanvases);
  bestRefreshBtn.addEventListener('click', refreshBestSections);

  async function init() {
    await initWasm();
    await initServiceWorker();
    
    // If Service Worker didn't claim the page yet, or we are on a platform without SW,
    // we still try to fetch. But initServiceWorker waits for 'ready'.
    fetchAirports();
    fetchHealth();
    fetchBest();
  }

  resizeAllCanvases();
  setActiveField('from');
  statusEl.textContent = '지도를 클릭하거나 공항 코드를 입력하세요.';
  renderResults(null);
  
  init();
});
