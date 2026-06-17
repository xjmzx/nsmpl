import type { SVGProps } from "react";

/**
 * The suite's "leaf" glyph — a simple almond blade + midrib, drawn in the
 * lucide idiom (24×24, currentColor stroke, round caps/joins, stroke-width 2)
 * so it drops in anywhere a lucide icon does: `<LeafIcon size={14} />`.
 *
 * Shared with ndisc.tree (and the canonical ndisc): a clip is a leaf you've
 * plucked from the tree, so the leaf is the suite-wide mark for sample/clip
 * and audio-presence affordances.
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
      {/* blade — pointed almond (tip top, stem base bottom) */}
      <path d="M12 21C6 16 6 9 12 4C18 9 18 16 12 21Z" />
      {/* midrib */}
      <path d="M12 20V5" />
    </svg>
  );
}
