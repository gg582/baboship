/**
 * candidate_routes.js — Heuristic candidate route generator.
 *
 * Generates up to 10 plausible parcel transport routes between an origin and
 * a destination airport using the flight_kernel WASM module.
 *
 * This module is entirely independent of the existing tracking system.
 * It only produces structured data; it does not call any existing functions.
 */

/**
 * @typedef {Object} CandidateRoute
 * @property {string}   origin            IATA origin code
 * @property {string}   destination       IATA destination code
 * @property {string[]} hubs              intermediate hub IATA codes
 * @property {number}   hubCount
 * @property {number[]} segmentDistances  km per leg
 * @property {number[]} segmentHours      flight hours per leg
 * @property {number[]} transferHours     ground transfer hours per hub
 * @property {number}   totalFlightHours  total flight + transfer time
 * @property {number}   plausibilityScore 0-100
 * @property {number}   rank              1-based rank
 */

/**
 * Generate top-10 candidate routes between origin and destination.
 *
 * @param {string} originIata     3-letter origin IATA code
 * @param {string} destIata       3-letter destination IATA code
 * @param {Object} flightKernel   kernel object returned by createFlightKernel()
 * @returns {CandidateRoute[]}
 */
export function generateCandidateRoutes(originIata, destIata, flightKernel) {
  if (!flightKernel || typeof flightKernel.fkGenerateCandidates !== 'function') {
    throw new Error('Flight kernel not initialised — call fk_init() first.');
  }
  const json = flightKernel.fkGenerateCandidates(
    originIata.trim().toUpperCase(),
    destIata.trim().toUpperCase()
  );
  const raw = JSON.parse(json);
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map((r, i) => ({
    origin:           r.origin           || originIata,
    destination:      r.destination      || destIata,
    hubs:             Array.isArray(r.hubs) ? r.hubs : [],
    hubCount:         Number(r.hubCount) || 0,
    segmentDistances: Array.isArray(r.segmentDistances) ? r.segmentDistances : [],
    segmentHours:     Array.isArray(r.segmentHours)     ? r.segmentHours     : [],
    transferHours:    Array.isArray(r.transferHours)    ? r.transferHours    : [],
    totalFlightHours: Number(r.totalFlightHours) || 0,
    plausibilityScore: Number(r.plausibilityScore) || 0,
    rank:             i + 1,
  }));
}

/**
 * Build a human-readable route string for a candidate.
 * Example: "ICN → FRA → JFK"
 *
 * @param {CandidateRoute} candidate
 * @returns {string}
 */
export function formatCandidateRoute(candidate) {
  const stops = [candidate.origin, ...candidate.hubs, candidate.destination];
  return stops.join(' → ');
}
