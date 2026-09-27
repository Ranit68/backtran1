/**
 * Time helpers.
 *
 * Source timetables use plain wall-clock `TIME` values, and transit data
 * routinely runs past midnight (a 23:50 departure arriving 00:20). Times are
 * therefore handled as "minutes since midnight, possibly > 1440" rather than as
 * instants, matching how GTFS-style feeds represent late-night service.
 */

/** `04:30`, `4:30`, `04:30:00` and `25:10` all parse. Returns null otherwise. */
export function parseClockToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

/** Inverse of parseClockToMinutes. Hours past 24 are preserved. */
export function formatMinutesToClock(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Duration between two clock values, handling the past-midnight case.
 * Returns null if either side is unparseable.
 */
export function minutesBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  const from = parseClockToMinutes(start);
  const to = parseClockToMinutes(end);
  if (from === null || to === null) return null;
  // +24h when the "end" is earlier, i.e. the service crosses midnight.
  return to >= from ? to - from : to + 24 * 60 - from;
}

/** Minutes since local midnight for the current time. */
export function nowMinutes(date: Date = new Date()): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** True when `clock` departs at or after `fromMinutes` on the same service day. */
export function isAtOrAfter(clock: string | null | undefined, fromMinutes: number): boolean {
  const minutes = parseClockToMinutes(clock);
  if (minutes === null) return false;
  return minutes >= fromMinutes;
}

/**
 * Combines a calendar date with a minutes-since-midnight value, rolling the
 * date forward when the value is past 24:00.
 */
export function combineDateAndMinutes(dateISO: string, totalMinutes: number): string {
  const base = new Date(dateISO);
  if (Number.isNaN(base.getTime())) {
    return formatMinutesToClock(totalMinutes);
  }
  base.setHours(0, 0, 0, 0);
  base.setMinutes(base.getMinutes() + totalMinutes);
  return base.toISOString();
}

/** Rounds to at most `decimals` places and drops trailing zeros. */
export function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** `72.0` -> `"1h 12m"`, for human-readable durations in logs and docs. */
export function humanizeMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const remainder = total % 60;
  if (hours === 0) return `${remainder}m`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}
