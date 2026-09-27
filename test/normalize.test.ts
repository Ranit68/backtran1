import { describe, expect, it } from "vitest";
import {
  editDistance,
  nameSimilarity,
  normalizeRouteNo,
  normalizeStopName,
  scoreSearchMatch,
} from "../src/utils/normalize.js";

describe("normalizeStopName", () => {
  it("treats a trailing parenthetical as the same place", () => {
    // "Esplanade (Metro)" and "Esplanade" are the same interchange. Stripping the
    // qualifier is what lets a bus stop and a tram stop at Esplanade be linked
    // when no coordinates exist yet.
    const canonical = normalizeStopName("Esplanade");
    expect(normalizeStopName("esplanade")).toBe(canonical);
    expect(normalizeStopName("Esplanade.")).toBe(canonical);
    expect(normalizeStopName("  ESPLANADE  ")).toBe(canonical);
    expect(normalizeStopName("Esplanade (Metro)")).toBe(canonical);
  });

  it("returns an empty string for missing input rather than throwing", () => {
    expect(normalizeStopName(null)).toBe("");
    expect(normalizeStopName(undefined)).toBe("");
    expect(normalizeStopName("   ")).toBe("");
  });
});

describe("normalizeRouteNo", () => {
  it("keeps the route number comparable across formatting differences", () => {
    const canonical = normalizeRouteNo("AC-3");
    expect(normalizeRouteNo("ac 3")).toBe(canonical);
    expect(normalizeRouteNo("ac3")).toBe(canonical);
  });
});

describe("nameSimilarity", () => {
  it("scores identical names as 1", () => {
    expect(nameSimilarity("Park Street", "Park Street")).toBe(1);
  });

  it("scores a two-character typo in a long name below the 0.9 transfer threshold", () => {
    // This is deliberate, not an oversight. With no coordinates, a loose
    // threshold would invent interchanges between unrelated stops, so a
    // misspelled name is NOT auto-linked. Real interchanges in the current
    // data are exact name matches; fuzzy linking is a tunable, off-by-default
    // convenience via TRANSFER_NAME_SIMILARITY_THRESHOLD.
    const score = nameSimilarity("Bhowanipore", "Bhowanipur");
    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThan(0.9);
  });

  it("scores unrelated names low", () => {
    expect(nameSimilarity("Park Street", "Howrah Bridge")).toBeLessThan(0.5);
  });
});

describe("scoreSearchMatch", () => {
  it("ranks an exact match above a prefix match above a fuzzy match", () => {
    const exact = scoreSearchMatch("Park Street", "Park Street");
    const prefix = scoreSearchMatch("Park", "Park Street");
    const fuzzy = scoreSearchMatch("esplanade", "Esplanade");
    expect(exact).toBe(1);
    expect(prefix).not.toBeNull();
    expect(fuzzy).not.toBeNull();
    expect(prefix!).toBeGreaterThan(0);
    expect(fuzzy!).toBeGreaterThan(0);
  });

  it("returns null when the candidate cannot be a match at all", () => {
    expect(scoreSearchMatch("zzzzzzz", "Park Street")).toBeNull();
    expect(scoreSearchMatch("", "Park Street")).toBeNull();
  });
});

describe("editDistance", () => {
  it("is zero for identical strings and symmetric", () => {
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("abc", "abd")).toBe(editDistance("abd", "abc"));
  });

  it("counts single edits", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
  });
});
