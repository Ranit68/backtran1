/**
 * Stop-name normalisation and fuzzy matching -- specification section 21.
 *
 * IMPORTANT: this module NEVER writes back to the database. Normalised names
 * exist only in memory, for search, for graph node identity and for transfer
 * detection. The original `stop_name` from the source CSV is always what gets
 * returned to clients and what gets stored.
 */

/**
 * Words that carry no identity when comparing a bus stop against a Metro station
 * against a metro station. Stripping these is what lets "Esplanade (Bus Stop)"
 * and "Esplanade Metro Station" collapse to the same key without us hardcoding
 * a list of interchanges.
 */
const NOISE_TOKENS = new Set([
  "bus",
  "busstop",
  "busstands",
  "busstand",
  "stop",
  "stops",
  "halt",
  "halts",
  "railway",
  "station",
  "stations",
  "metro",
  "tram",
  "ferry",
  "brt",
  "terminus", // kept out below via KEEP_TOKENS
]);

/** Tokens that look generic but are genuinely part of a Kolkata place name. */
const KEEP_TOKENS = new Set(["terminus", "depot", "ghat", "bazaar", "bazar"]);

/**
 * Normalises a stop name into a stable comparison key.
 *
 * Steps: strip diacritics, lowercase, drop parenthetical annotations, drop
 * punctuation, drop generic transport noise words, collapse whitespace.
 */
export function normalizeStopName(input: string | null | undefined): string {
  if (!input) return "";

  let value = String(input);

  // "Gariahat Depot (In Gate)" -> "Gariahat Depot "
  value = value.replace(/\([^)]*\)/g, " ");

  // Split accents off base letters so "Dhakshin" variants and accented text
  // compare equal to their ASCII spellings.
  value = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  value = value.toLowerCase();

  // Ampersand reads as "and" before it is stripped.
  value = value.replace(/&/g, " and ");

  // Anything that is not a letter or a digit becomes a space.
  value = value.replace(/[^a-z0-9]+/g, " ");

  const tokens = value
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .filter((token) => KEEP_TOKENS.has(token) || !NOISE_TOKENS.has(token));

  return tokens.join(" ");
}

/**
 * Normalises a route identifier for identity comparisons.
 *
 * Route numbers are identifiers, not numbers (spec section 19). `26/17` and
 * `26-17` are the same route written two ways, so separators collapse --
 * but the digits and letters themselves are preserved exactly.
 */
export function normalizeRouteNo(input: string | null | undefined): string {
  if (!input) return "";
  return String(input)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Levenshtein edit distance, two-row implementation. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + cost;
      current[j] = Math.min(deletion, insertion, substitution);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[b.length] ?? 0;
}

/**
 * Similarity in [0, 1] between two raw stop names.
 *
 * Combines whole-string closeness with token overlap, so both
 * "Gariahat Depot" ~ "Gariahat Depot In Gate" and "Esplanade" ~ "Esplenade"
 * score highly while "Howrah" and "Dakshineswar" score near zero.
 */
export function nameSimilarity(a: string, b: string): number {
  const normA = normalizeStopName(a);
  const normB = normalizeStopName(b);

  if (normA.length === 0 || normB.length === 0) return 0;
  if (normA === normB) return 1;

  // Token overlap (Jaccard), guarding against a stop name with a long
  // "direction" suffix diluting the score.
  const tokensA = new Set(normA.split(" "));
  const tokensB = new Set(normB.split(" "));
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union === 0 ? 0 : intersection / union;

  const distance = editDistance(normA, normB);
  const longest = Math.max(normA.length, normB.length);
  const levenshteinScore = longest === 0 ? 0 : 1 - distance / longest;

  // Containment: "gariahat" inside "gariahat depot in gate" is a strong signal.
  const containment = normA.includes(normB) || normB.includes(normA) ? 1 : 0;

  return Math.max(levenshteinScore, jaccard, containment * 0.95);
}

/**
 * Relevance score for a search result, or null when the candidate does not
 * match at all. Higher is better.
 *
 * The query is normalised once and then compared as: exact match > prefix
 * match > word-prefix match > substring match > fuzzy match. Callers can use
 * the score to sort and to apply their own cut-off.
 */
export function scoreSearchMatch(query: string, candidate: string): number | null {
  const q = normalizeStopName(query);
  const c = normalizeStopName(candidate);

  if (q.length === 0 || c.length === 0) return null;
  if (q === c) return 1;

  if (c.startsWith(q)) return 0.95;
  if (c.includes(q)) return 0.85;

  // Every query word must be a prefix of some candidate word. This is what
  // makes "espl dhaka" style partial input and multi-word queries behave.
  const queryTokens = q.split(" ");
  const candidateTokens = c.split(" ");
  const allTokensMatch = queryTokens.every((queryToken) =>
    candidateTokens.some((candidateToken) => candidateToken.startsWith(queryToken)),
  );
  if (allTokensMatch) return 0.75;

  const similarity = nameSimilarity(query, candidate);
  if (similarity >= 0.72) return similarity * 0.7;

  return null;
}

/**
 * Stable identity for a stop within the transport graph.
 *
 * Two rows describing the same physical place produce the same node id only if
 * they share mode, operator AND normalised name. That is intentionally strict:
 * spec section 12 forbids auto-connecting every similarly named stop, so the
 * graph starts from "one node per distinct (mode, operator, name)" and lets
 * TransferService add explicit links between them.
 */
export function buildStopNodeId(mode: string, operator: string | null | undefined, name: string): string {
  const normalizedName = normalizeStopName(name).replace(/\s+/g, "-") || "unnamed";
  const normalizedOperator = (operator ?? "unknown").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${mode.toLowerCase()}:${normalizedOperator}:${normalizedName}`;
}

/** Stable identity for a route within the graph. */
export function buildRouteNodeId(mode: string, operator: string | null | undefined, routeNo: string): string {
  return `${mode.toLowerCase()}:${(operator ?? "unknown").trim().toLowerCase()}:route:${normalizeRouteNo(routeNo)}`;
}
