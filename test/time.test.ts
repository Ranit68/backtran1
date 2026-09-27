import { describe, expect, it } from "vitest";
import {
  formatMinutesToClock,
  minutesBetween,
  parseClockToMinutes,
} from "../src/utils/time.js";

describe("parseClockToMinutes", () => {
  it("parses plain wall-clock times", () => {
    expect(parseClockToMinutes("04:30")).toBe(270);
    expect(parseClockToMinutes("4:30")).toBe(270);
    expect(parseClockToMinutes("04:30:15")).toBe(270);
    expect(parseClockToMinutes("23:59")).toBe(1439);
  });

  it("keeps hours past 24, which GTFS-style feeds use for late-night service", () => {
    expect(parseClockToMinutes("25:10")).toBe(1510);
  });

  it("rejects malformed values instead of guessing", () => {
    expect(parseClockToMinutes("24:75")).toBeNull();
    expect(parseClockToMinutes("noon")).toBeNull();
    expect(parseClockToMinutes("")).toBeNull();
    expect(parseClockToMinutes(null)).toBeNull();
    expect(parseClockToMinutes(undefined)).toBeNull();
  });
});

describe("minutesBetween", () => {
  it("computes a simple duration", () => {
    expect(minutesBetween("10:00", "10:45")).toBe(45);
  });

  it("adds 24 hours when the service crosses midnight", () => {
    // 23:50 -> 00:20 is 30 minutes, not -1430.
    expect(minutesBetween("23:50", "00:20")).toBe(30);
  });

  it("returns null when either side is missing or unparseable", () => {
    expect(minutesBetween(null, "10:00")).toBeNull();
    expect(minutesBetween("10:00", null)).toBeNull();
    expect(minutesBetween("10:00", "oops")).toBeNull();
  });
});

describe("formatMinutesToClock", () => {
  it("round-trips through parseClockToMinutes", () => {
    expect(formatMinutesToClock(270)).toBe("04:30");
    expect(parseClockToMinutes(formatMinutesToClock(1510))).toBe(1510);
  });

  it("zero-pads and never emits negative minutes", () => {
    expect(formatMinutesToClock(0)).toBe("00:00");
    expect(formatMinutesToClock(65)).toBe("01:05");
    expect(formatMinutesToClock(-10)).toBe("00:00");
  });
});
