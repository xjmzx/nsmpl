import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";

/// Thin full-height bar a flank panel collapses to, freeing horizontal width
/// for the Library. Shows the panel's icon, an inward expand chevron, and a
/// vertical label. The whole strip is the click target to expand.
export function CollapsedStrip({
  label,
  icon,
  side,
  onExpand,
  className,
}: {
  label: string;
  icon: ReactNode;
  /** Which flank the panel sits on — sets the expand chevron direction. */
  side: "left" | "right";
  onExpand: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      title={`Expand ${label}`}
      aria-label={`Expand ${label}`}
      className={cn(
        "rounded-xl bg-panel shadow-md flex flex-col items-center gap-2 py-3",
        "text-muted hover:text-fg transition-colors cursor-pointer",
        className,
      )}
    >
      {icon}
      {side === "left" ? (
        <ChevronRight size={14} />
      ) : (
        <ChevronLeft size={14} />
      )}
      <span className="[writing-mode:vertical-rl] rotate-180 text-[10px] uppercase tracking-wider">
        {label}
      </span>
    </button>
  );
}
