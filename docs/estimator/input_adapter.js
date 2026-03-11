/**
 * input_adapter.js — Adapter between CandidateRoutes and existing functions.
 *
 * The only place this module interacts with the existing system is by calling
 * the `runRouteSearch` function that is already part of the app.  It treats
 * that function as a black box and only prepares the input data in the
 * expected format:
 *
 *   runRouteSearch(fromIata: string, toIata: string, maxTransfers: number)
 *     → Promise<{ paths: RouteResult[] }>
 *
 * Architecture note:
 *   The adapter receives the `runRouteSearch` function as a parameter so that
 *   this module has no direct import-time dependency on the existing modules.
 */

/**
 * @typedef {Object} AdaptedResult
 * @property {import('./candidate_routes.js').CandidateRoute} candidate
 * @property {Object|null} routeResult  raw output from the existing function
 * @property {string|null} error        error message, or null on success
 */

/**
 * Pass each candidate route through the existing route-search function and
 * collect the results.
 *
 * @param {import('./candidate_routes.js').CandidateRoute[]} candidates
 * @param {Function} runRouteSearch  existing black-box function
 * @param {{ maxTransfers?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<AdaptedResult[]>}
 */
export async function adaptAndQuery(candidates, runRouteSearch, opts = {}) {
  const maxTransfers = Number.isFinite(opts.maxTransfers) ? opts.maxTransfers : 2;
  const results = [];

  for (const candidate of candidates) {
    try {
      const data = await runRouteSearch(
        candidate.origin,
        candidate.destination,
        maxTransfers
      );
      results.push({ candidate, routeResult: data ?? null, error: null });
    } catch (err) {
      results.push({ candidate, routeResult: null, error: err.message ?? String(err) });
    }
  }

  return results;
}

/**
 * Extract the first (best) path from a route-search result object.
 *
 * @param {Object|null} routeResult
 * @returns {Object|null}
 */
export function extractBestPath(routeResult) {
  if (!routeResult) return null;
  const paths = Array.isArray(routeResult.paths) ? routeResult.paths : [];
  return paths.length > 0 ? paths[0] : null;
}
