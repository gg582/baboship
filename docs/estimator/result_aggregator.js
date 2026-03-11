/**
 * result_aggregator.js — Aggregates adapted route results into a probabilistic
 * ETA distribution.
 *
 * This module is completely independent of the existing tracking system.
 * It combines:
 *   1. Flight-kernel ETA distribution (from fk_compute_eta_distribution)
 *   2. Route-quality signals obtained via the input adapter
 * to produce a final, richer estimate with confidence information.
 */

/**
 * @typedef {Object} EtaDistribution
 * @property {number}   lowerHours        optimistic arrival (hours from now)
 * @property {number}   modeHours         most-likely arrival (hours from now)
 * @property {number}   upperHours        pessimistic arrival (hours from now)
 * @property {number}   confidence        0–1
 * @property {Object}   delayBreakdown    per-phase hour estimates
 * @property {RankedCandidate[]} candidates  top-10 candidates with scores
 */

/**
 * @typedef {Object} RankedCandidate
 * @property {number}   rank
 * @property {string}   route         human-readable route string
 * @property {number}   totalHours    hours incl. ground delays
 * @property {number}   score         0-100 plausibility score
 * @property {boolean}  hasRouteData  true when the existing engine confirmed the route
 * @property {number}   distanceKm    total distance (km) from existing engine, or 0
 * @property {number}   efficiency    route efficiency from existing engine, or 0
 */

/**
 * Aggregate adapted results and the kernel ETA into a final distribution.
 *
 * @param {import('./input_adapter.js').AdaptedResult[]} adaptedResults
 * @param {Object} flightKernel   kernel object with fkComputeEtaDistribution
 * @param {import('./candidate_routes.js').CandidateRoute[]} candidates
 * @returns {EtaDistribution}
 */
export function aggregateResults(adaptedResults, flightKernel, candidates) {
  /* Build enriched candidates list */
  const rankedCandidates = candidates.map((c, i) => {
    const adapted = adaptedResults[i] || null;
    const bestPath = adapted?.routeResult?.paths?.[0] ?? null;
    const stops = [c.origin, ...c.hubs, c.destination];
    return {
      rank:         c.rank,
      route:        stops.join(' → '),
      totalHours:   c.totalFlightHours,
      score:        c.plausibilityScore,
      hasRouteData: bestPath !== null,
      distanceKm:   bestPath ? (Number(bestPath.totalDistanceKm) || 0) : 0,
      efficiency:   bestPath ? (Number(bestPath.efficiency)       || 0) : 0,
    };
  });

  /* Boost scores for candidates where the existing engine confirmed the route */
  for (const rc of rankedCandidates) {
    if (rc.hasRouteData && rc.distanceKm > 0) {
      rc.score = Math.min(100, rc.score * 1.15);
    }
  }
  rankedCandidates.sort((a, b) => b.score - a.score);

  /* Compute ETA using the flight kernel */
  const candidatesForKernel = rankedCandidates.map(rc => ({
    totalFlightHours: rc.totalHours,
    plausibilityScore: rc.score,
  }));

  let etaJson;
  try {
    etaJson = JSON.parse(
      flightKernel.fkComputeEtaDistribution(JSON.stringify(candidatesForKernel))
    );
  } catch {
    etaJson = {
      lowerHours: 24, modeHours: 72, upperHours: 168,
      confidence: 0.2,
      delayBreakdown: {
        flightHours: 12, originHandlingHours: 7,
        departureWaitHours: 3.5, customsHours: 13, lastMileHours: 26,
      },
      candidates: [],
    };
  }

  return {
    lowerHours:     etaJson.lowerHours,
    modeHours:      etaJson.modeHours,
    upperHours:     etaJson.upperHours,
    confidence:     etaJson.confidence,
    delayBreakdown: etaJson.delayBreakdown || {},
    candidates:     rankedCandidates,
  };
}

/**
 * Format an hour count as a human-readable duration string.
 * e.g.  36.5  →  "1일 12시간"
 *        8.0  →  "8시간"
 *
 * @param {number} hours
 * @returns {string}
 */
export function formatHours(hours) {
  const h = Math.round(hours);
  if (h < 24) return `${h}시간`;
  const days = Math.floor(h / 24);
  const rem  = h % 24;
  return rem > 0 ? `${days}일 ${rem}시간` : `${days}일`;
}

const MS_PER_HOUR = 3_600_000;

/**
 * Compute an arrival date string given departure "now" and an offset in hours.
 *
 * @param {number} offsetHours
 * @returns {string}  formatted as "YYYY-MM-DD (요일)"
 */
export function arrivalDateString(offsetHours) {
  const d = new Date(Date.now() + offsetHours * MS_PER_HOUR);
  const ymd = d.toLocaleDateString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dow = d.toLocaleDateString('ko-KR', { weekday: 'short' });
  return `${ymd} (${dow})`;
}
