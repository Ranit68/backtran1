import { AppError, ErrorCode } from "../utils/errors.js";
import { TRAM_WITHDRAWAL_NOTE } from "../types/transport.js";

/**
 * Retired Tram endpoints -- every one answers HTTP 410 Gone.
 *
 * The Tram service was withdrawn, and the legacy `wbtc_tram_routes` data is left
 * in the database untouched. A blanket 410 is used in preference to 404 so a
 * client that still calls these paths learns the endpoint is permanently gone
 * rather than mistyped, and 410 rather than 501 because no configuration change
 * will bring it back.
 *
 * Registered as a wildcard under `/tram/*`, so even a path that never existed
 * answers with the retirement reason instead of a bare 404.
 */
export function tramWithdrawn(): AppError {
  return new AppError(ErrorCode.TRAM_SERVICE_WITHDRAWN, TRAM_WITHDRAWAL_NOTE, {
    withdrawn: true,
    replacedBy: "METRO",
  });
}
