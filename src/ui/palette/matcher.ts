/**
 * The command palette's matcher. In-house on purpose: a fuzzy-search library would cost more than
 * the whole palette. It scores a subsequence match, rewards hits at the start of a word, and
 * folds case and Latin diacritics so that "Bjork" finds "Björk" — a DJ typing a title from memory
 * rarely reproduces its accents.
 */

/** Lower-cased, diacritic-free form used for every comparison. */
export function normalise(text: string): string {
  let out = "";
  for (const char of text.normalize("NFKD").toLowerCase()) {
    if (char >= "\u0300" && char <= "\u036f") continue; // Latin combining marks
    out += char;
  }
  return out;
}

const isBoundary = (char: string | undefined): boolean =>
  char === undefined || char === " " || char === "-" || char === "·" || char === "(" || char === "/";

/**
 * Score of `query` inside `text`: null when the query is not a subsequence of it. Higher is
 * better — consecutive characters and hits at the start of a word count for more, and a shorter
 * haystack wins a tie.
 */
export function score(query: string, text: string): number | null {
  const needle = normalise(query).trim();
  const hay = normalise(text);
  if (!needle) return 0;
  if (!hay) return null;
  let total = 0;
  let at = 0;
  let streak = 0;
  for (const char of needle) {
    if (char === " ") {
      streak = 0;
      continue;
    }
    const found = hay.indexOf(char, at);
    if (found < 0) return null;
    let points = 1;
    if (isBoundary(hay[found - 1])) points += 6;
    if (found === at && at > 0) {
      streak += 1;
      points += 2 + streak;
    } else {
      streak = 0;
    }
    if (found === 0) points += 4;
    total += points;
    at = found + 1;
  }
  // A short label that contains the query beats a long one that merely happens to.
  return total + Math.max(0, 20 - hay.length * 0.1);
}

export interface Rankable {
  id: string;
  /** Everything worth matching against: label, group, track artist … */
  haystack: string;
  /** Higher wins ties: recency and source order. */
  weight?: number;
}

/** The matching items, best first. An empty query keeps the input order (weighted). */
export function rank<T extends Rankable>(query: string, items: readonly T[], limit = 40): T[] {
  const scored: { item: T; score: number; index: number }[] = [];
  for (const [index, item] of items.entries()) {
    const value = score(query, item.haystack);
    if (value === null) continue;
    scored.push({ item, score: value + (item.weight ?? 0), index });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((entry) => entry.item);
}
