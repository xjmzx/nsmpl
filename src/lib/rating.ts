// Reaction classification — ported from ndisc.view's lib/rating.ts so the
// reaction maths stays identical across the suite (ndisc / ndisc.blobtree
// / ndisc.smpl / ndisc.view all share the +/- convention).

export const REACTION_UP = "+";
export const REACTION_DOWN = "-";
export const REACTION_INFO = "ℹ️";

export type ReactionKind = "up" | "down" | "info" | "other";

/** Classify a kind:7 event's content into our buckets. */
export function classifyReaction(content: string): ReactionKind {
  const c = content.trim();
  if (c === REACTION_UP) return "up";
  if (c === REACTION_DOWN) return "down";
  if (c === REACTION_INFO || c === "+info" || c === "info") return "info";
  return "other";
}

// Display ceiling so a single event never advertises a runaway count.
export const DISPLAY_CAP = 99;
export function displayCount(n: number): string {
  return n > DISPLAY_CAP ? `${DISPLAY_CAP}+` : String(n);
}
