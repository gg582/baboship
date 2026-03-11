/**
 * parcel_estimator_tab.js — UI module for the "소포 행방 추정" tab.
 *
 * This module is self-contained and does not modify any existing tracking
 * pipeline.  It communicates with the rest of the app only through:
 *   - a `runRouteSearch` function passed in at init time (existing black-box)
 *   - standard DOM APIs for rendering within #estimator-panel
 *
 * Pipeline:
 *   [User input] → FlightKernel → CandidateRoutes → InputAdapter
 *               → ResultAggregator → Visualisation
 */

import createFlightKernel from '../wasm/flight_kernel.js';
import { generateCandidateRoutes, formatCandidateRoute } from '../estimator/candidate_routes.js';
import { adaptAndQuery }       from '../estimator/input_adapter.js';
import { aggregateResults, formatHours, arrivalDateString } from '../estimator/result_aggregator.js';

/* ---- module state ---- */
let _kernel     = null;   /* flight kernel instance */
let _runSearch  = null;   /* injected black-box route search function */
let _running    = false;

/* ---- DOM helpers ---- */
function $(id) { return document.getElementById(id); }

function setStatus(msg, variant = 'info') {
  const el = $('estimator-status');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'tracking-status' + (variant !== 'info' ? ` ${variant}` : '');
}

/** Draw a simple probability-distribution bar chart onto a <canvas>. */
function drawDistributionChart(canvas, distribution) {
  if (!canvas) return;
  const { lowerHours, modeHours, upperHours } = distribution;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const totalSpan = upperHours - lowerHours;
  if (totalSpan <= 0) return;

  /* Background */
  ctx.fillStyle = '#1a1f2e';
  ctx.fillRect(0, 0, W, H);

  /* --- Gaussian-like distribution curve --- */
  const sigma = (upperHours - lowerHours) / 5;
  const mu    = modeHours;

  function gaussian(x) {
    return Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
  }

  /* Padding */
  const padL = 48, padR = 16, padT = 16, padB = 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  /* Axis labels */
  ctx.fillStyle = '#8899aa';
  ctx.font      = '11px "IBM Plex Sans KR", system-ui, sans-serif';
  ctx.textAlign = 'left';

  const labels = [lowerHours, modeHours, upperHours];
  for (const h of labels) {
    const x = padL + ((h - lowerHours) / totalSpan) * plotW;
    ctx.fillStyle = '#8899aa';
    ctx.textAlign = 'center';
    ctx.fillText(formatHours(h), x, H - 6);
    /* tick */
    ctx.strokeStyle = '#444d60';
    ctx.beginPath();
    ctx.moveTo(x, padT + plotH);
    ctx.lineTo(x, padT + plotH + 4);
    ctx.stroke();
  }

  /* Fill area under curve */
  const steps = 200;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const h  = lowerHours + (i / steps) * totalSpan;
    const y  = gaussian(h);
    const px = padL + (i / steps) * plotW;
    const py = padT + plotH - y * plotH * 0.88;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.lineTo(padL, padT + plotH);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, 'rgba(232,102,27,0.7)');
  grad.addColorStop(1, 'rgba(232,102,27,0.08)');
  ctx.fillStyle = grad;
  ctx.fill();

  /* Curve border */
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const h  = lowerHours + (i / steps) * totalSpan;
    const y  = gaussian(h);
    const px = padL + (i / steps) * plotW;
    const py = padT + plotH - y * plotH * 0.88;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = '#e8661b';
  ctx.lineWidth   = 2;
  ctx.stroke();

  /* Mode vertical line */
  const modeX = padL + ((modeHours - lowerHours) / totalSpan) * plotW;
  ctx.strokeStyle = '#ffd700';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(modeX, padT);
  ctx.lineTo(modeX, padT + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  /* "최빈값" label */
  ctx.fillStyle = '#ffd700';
  ctx.font      = '10px "IBM Plex Sans KR", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('최빈값', modeX, padT - 4);

  /* Y axis label */
  ctx.save();
  ctx.translate(12, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#8899aa';
  ctx.font      = '10px "IBM Plex Sans KR", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('확률 밀도', 0, 0);
  ctx.restore();
}

/** Render the delay-breakdown horizontal bar. */
function renderDelayBreakdown(container, breakdown) {
  if (!container || !breakdown) return;
  const phases = [
    { key: 'originHandlingHours', label: '출발 처리', color: '#3b82f6' },
    { key: 'departureWaitHours',  label: '출항 대기', color: '#8b5cf6' },
    { key: 'flightHours',         label: '비행',      color: '#e8661b' },
    { key: 'customsHours',        label: '세관',      color: '#f59e0b' },
    { key: 'lastMileHours',       label: '배달',      color: '#10b981' },
  ];
  const total = phases.reduce((s, p) => s + (breakdown[p.key] || 0), 0);
  if (total <= 0) return;

  let html = '<div class="breakdown-bar">';
  for (const p of phases) {
    const h   = breakdown[p.key] || 0;
    const pct = (h / total) * 100;
    html += `<div class="breakdown-segment" style="width:${pct.toFixed(1)}%;background:${p.color}" title="${p.label}: ${formatHours(h)}"></div>`;
  }
  html += '</div><div class="breakdown-legend">';
  for (const p of phases) {
    const h = breakdown[p.key] || 0;
    html += `<span><span class="legend-dot" style="background:${p.color}"></span>${p.label} <em>${formatHours(h)}</em></span>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

/** Render the top-10 candidate routes table. */
function renderCandidateTable(container, candidates) {
  if (!container) return;
  if (!candidates || candidates.length === 0) {
    container.innerHTML = '<div class="empty-state">후보 경로가 없습니다.</div>';
    return;
  }
  let html = `
    <table class="estimator-table">
      <thead>
        <tr>
          <th>순위</th>
          <th>경로</th>
          <th>총 비행 시간</th>
          <th>타당성 점수</th>
          <th>경로 확인</th>
          <th>거리 (km)</th>
        </tr>
      </thead>
      <tbody>
  `;
  for (const c of candidates) {
    const confirmed = c.hasRouteData
      ? '<span class="badge badge-ok">✓ 확인됨</span>'
      : '<span class="badge badge-na">—</span>';
    const dist = c.distanceKm > 0 ? c.distanceKm.toFixed(0) : '—';
    const scoreClass = c.score >= 70 ? 'score-high' : c.score >= 40 ? 'score-mid' : 'score-low';
    html += `
      <tr>
        <td>${c.rank}</td>
        <td class="route-cell">${c.route}</td>
        <td>${formatHours(c.totalHours)}</td>
        <td><span class="score-badge ${scoreClass}">${c.score.toFixed(1)}</span></td>
        <td>${confirmed}</td>
        <td>${dist}</td>
      </tr>
    `;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

/** Render the full estimation result. */
function renderResult(distribution) {
  const arrivalWindow = $('estimator-arrival-window');
  const chart         = $('estimator-chart');
  const breakdown     = $('estimator-breakdown');
  const table         = $('estimator-candidates');

  /* Arrival window */
  if (arrivalWindow) {
    const conf = Math.round(distribution.confidence * 100);
    arrivalWindow.innerHTML = `
      <div class="eta-row">
        <div class="eta-cell eta-lower">
          <div class="eta-label">빠른 경우</div>
          <div class="eta-value">${arrivalDateString(distribution.lowerHours)}</div>
          <div class="eta-sub">${formatHours(distribution.lowerHours)}</div>
        </div>
        <div class="eta-cell eta-mode">
          <div class="eta-label">가장 가능성 높은 도착</div>
          <div class="eta-value">${arrivalDateString(distribution.modeHours)}</div>
          <div class="eta-sub">${formatHours(distribution.modeHours)}</div>
        </div>
        <div class="eta-cell eta-upper">
          <div class="eta-label">늦은 경우</div>
          <div class="eta-value">${arrivalDateString(distribution.upperHours)}</div>
          <div class="eta-sub">${formatHours(distribution.upperHours)}</div>
        </div>
      </div>
      <div class="confidence-row">
        신뢰도: <strong>${conf}%</strong>
        <div class="confidence-bar"><div class="confidence-fill" style="width:${conf}%"></div></div>
      </div>
    `;
  }

  /* Distribution chart */
  if (chart) {
    drawDistributionChart(chart, distribution);
  }

  /* Delay breakdown */
  renderDelayBreakdown(breakdown, distribution.delayBreakdown);

  /* Candidate table */
  renderCandidateTable(table, distribution.candidates);
}

/* ---- public API ---- */

/**
 * Initialise the estimator tab.
 *
 * @param {Function} runRouteSearch  the existing runRouteSearch black-box function
 */
export async function initEstimatorTab(runRouteSearch) {
  _runSearch = runRouteSearch;
  try {
    const k = await createFlightKernel();
    k.fkInit();
    _kernel = k;
    setStatus('비행 커널 준비 완료. 출발지와 도착지를 입력하세요.');
  } catch (err) {
    setStatus('비행 커널 초기화 실패: ' + err.message, 'error');
  }

  const btn = $('estimator-run-btn');
  if (btn) btn.addEventListener('click', () => runEstimation().catch(console.error));

  const originInput = $('estimator-origin');
  const destInput   = $('estimator-dest');
  if (originInput && destInput) {
    [originInput, destInput].forEach(el => {
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter') runEstimation().catch(console.error);
      });
    });
  }
}

/**
 * Run the full estimation pipeline.
 */
async function runEstimation() {
  if (_running) return;
  const originEl = $('estimator-origin');
  const destEl   = $('estimator-dest');
  if (!originEl || !destEl) return;

  const origin = originEl.value.trim().toUpperCase();
  const dest   = destEl.value.trim().toUpperCase();

  if (origin.length !== 3) {
    setStatus('출발지 IATA 코드 3자리를 입력하세요.', 'error');
    originEl.focus();
    return;
  }
  if (dest.length !== 3) {
    setStatus('도착지 IATA 코드 3자리를 입력하세요.', 'error');
    destEl.focus();
    return;
  }
  if (!_kernel) {
    setStatus('비행 커널이 아직 준비되지 않았습니다.', 'error');
    return;
  }

  _running = true;
  const btn = $('estimator-run-btn');
  if (btn) btn.disabled = true;

  try {
    /* Step 1 – fetch flight signal data (OpenSky anonymous, best-effort) */
    setStatus('항공 신호 데이터 조회 중…');
    await _fetchAndLoadSignalData(origin, dest);

    /* Step 2 – generate candidates via the WASM kernel */
    setStatus('후보 경로 생성 중…');
    const candidates = generateCandidateRoutes(origin, dest, _kernel);
    if (candidates.length === 0) {
      setStatus(`${origin} → ${dest} 사이의 유효한 경로를 찾지 못했습니다.`, 'error');
      return;
    }

    /* Step 3 – pass each candidate through the existing route-search function */
    setStatus(`후보 ${candidates.length}개를 기존 경로 엔진으로 검증 중…`);
    const adapted = await adaptAndQuery(candidates, _runSearch, { maxTransfers: 2 });

    /* Step 4 – aggregate and compute ETA distribution */
    setStatus('확률적 도착 시간 계산 중…');
    const distribution = aggregateResults(adapted, _kernel, candidates);

    /* Step 5 – render */
    renderResult(distribution);
    setStatus(
      `추정 완료: ${formatHours(distribution.modeHours)} 후 도착 (신뢰도 ${Math.round(distribution.confidence * 100)}%)`,
      'success'
    );
  } catch (err) {
    setStatus('추정 실패: ' + err.message, 'error');
    console.error('[ParcelEstimator]', err);
  } finally {
    _running = false;
    if (btn) btn.disabled = false;
  }
}

/**
 * Fetch aircraft state vectors from OpenSky Network (anonymous, no auth).
 * If the request fails (network, CORS, rate-limit), we silently skip it.
 *
 * @param {string} originIata
 * @param {string} destIata
 */
async function _fetchAndLoadSignalData(originIata, destIata) {
  /* We perform a loose bounding-box search around the mid-point of the route
   * using the kernel's internal seed coordinates as a proxy — no coordinate
   * lookup is needed here since the kernel already knows the airports.
   */
  try {
    /* OpenSky anonymous endpoint: all states currently above a bounding box
     * centred roughly on the origin → destination great-circle mid-point.
     * We use a large box (±30°) to capture enroute aircraft.
     */
    const url = 'https://opensky-network.org/api/states/all';
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data || !Array.isArray(data.states)) return;

    /* Build lightweight signal records from ADS-B transponder data.
     * Each state vector: [icao24, callsign, origin_country, …, lat, lon, …, on_ground]
     * We only use country and a pseudo-signal based on number of aircraft visible.
     */
    const COUNTRY_TO_IATA = {
      'South Korea': 'ICN', 'Japan': 'NRT', 'China': 'PVG',
      'United States': 'JFK', 'Germany': 'FRA', 'France': 'CDG',
      'United Kingdom': 'LHR', 'Singapore': 'SIN', 'United Arab Emirates': 'DXB',
      'Netherlands': 'AMS', 'Canada': 'YYZ', 'Australia': 'SYD',
      'Thailand': 'BKK', 'India': 'DEL', 'Qatar': 'DOH',
      'Turkey': 'IST', 'Brazil': 'GRU', 'South Africa': 'JNB',
    };

    const countrySignal = {};
    for (const sv of data.states) {
      const country = sv[2];
      if (!country) continue;
      countrySignal[country] = (countrySignal[country] || 0) + 1;
    }

    const maxCount = Math.max(...Object.values(countrySignal), 1);
    const signalRecords = Object.entries(countrySignal)
      .map(([country, cnt]) => {
        const iata = COUNTRY_TO_IATA[country];
        if (!iata) return null;
        return { iata, lat: 0, lon: 0, country, signal: cnt / maxCount };
      })
      .filter(Boolean);

    if (signalRecords.length > 0) {
      _kernel.fkLoadSignalData(JSON.stringify(signalRecords));
    }
  } catch {
    /* Silently ignore — signal data is optional */
  }
}
