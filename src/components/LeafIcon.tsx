import type { SVGProps } from "react";
import { cn } from "../lib/cn";

/**
 * The suite's "leaf" glyph — a simple almond blade + midrib in the lucide
 * idiom. Used for affordance / brand marks (the audio filter toggle, headers).
 * Quantity is shown with LeafDots.
 */
export function LeafIcon({
  size = 24,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 21C6 16 6 9 12 4C18 9 18 16 12 21Z" />
      <path d="M12 20V5" />
    </svg>
  );
}

/**
 * Leaf-dots — the suite's diagrammatic quantity glyph (shared with ndisc /
 * ndisc.tree). A leaf is a track/clip; each one is a flat, muted leaf-green
 * dot, and the dots stack into a compact cluster (wrap at 5 per row) so the
 * count itself is the picture. Renders nothing for 0 (a sampling gap). Capped
 * at `max` (default 99); the exact figure stays in the hover title.
 */
// Optimal column count for `n` dots within `maxCols`: single row up to the
// smaller of 5 / maxCols, then the fewest rows that fit, columns balanced
// (6→2×3, 8→2×4, 7→4+3). Low maxCols = taller/narrower; high = shorter/wider.
function dotCols(n: number, maxCols: number): number {
  if (n <= Math.min(5, maxCols)) return n;
  const rows = Math.ceil(n / maxCols);
  return Math.ceil(n / rows);
}

export function LeafDots({
  n,
  total,
  max = 99,
  unit = "track",
  maxCols = 5,
  className,
}: {
  /** Present count (solid green dots). */
  n: number | null | undefined;
  /** Expected total — extra (missing) slots render at 25%. */
  total?: number | null;
  max?: number;
  unit?: string;
  /** Max dots per row — lower = taller/narrower, higher = shorter/wider. */
  maxCols?: number;
  className?: string;
}) {
  const present = Math.min(Math.max(n ?? 0, 0), max);
  const expected = total != null ? Math.min(Math.max(total, 0), max) : present;
  const shown = Math.max(present, expected);
  if (shown <= 0) return null;
  const missing = Math.max(expected - present, 0);
  const cols = dotCols(shown, maxCols);
  const title =
    total != null
      ? `${present} of ${total} ${unit}${total === 1 ? "" : "s"}${
          missing > 0 ? ` · ${missing} missing` : " · complete"
        }`
      : `${present}${present >= max ? "+" : ""} ${unit}${present === 1 ? "" : "s"}`;
  return (
    <span
      className={cn("inline-grid gap-[2px] w-max", className)}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      title={title}
      aria-label={title}
    >
      {Array.from({ length: shown }, (_, i) => (
        <span
          key={i}
          className={cn(
            "w-1 h-1 rounded-full",
            i < present ? "bg-ok/70" : "bg-ok/25",
          )}
        />
      ))}
    </span>
  );
}
