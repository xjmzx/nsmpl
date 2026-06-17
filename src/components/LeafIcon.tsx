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
export function LeafDots({
  n,
  max = 99,
  unit = "track",
  className,
}: {
  n: number | null | undefined;
  max?: number;
  unit?: string;
  className?: string;
}) {
  const raw = Math.max(n ?? 0, 0);
  const count = Math.min(raw, max);
  if (count <= 0) return null;
  const title = `${raw}${raw >= max ? "+" : ""} ${unit}${raw === 1 ? "" : "s"}`;
  return (
    <span
      className={cn("inline-grid grid-cols-5 gap-[2px] w-max", className)}
      title={title}
      aria-label={title}
    >
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="w-1 h-1 rounded-full bg-ok/70" />
      ))}
    </span>
  );
}
