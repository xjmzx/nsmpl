import { ReactNode } from "react";
import { cn } from "../lib/cn";

interface SectionProps {
  title: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
  // Optional click handler on the whole card — used for focus-routing
  // in multi-track layouts.
  onClick?: () => void;
  // Click handler on the header bar (title + icon). When provided,
  // the whole header reads as interactive (cursor + hover tint) and
  // triggers this callback. Used by collapsible panels — replaces
  // the per-panel chevron toggles.
  onTitleClick?: () => void;
  // When true, the children wrapper becomes a flex column that fills
  // the section's remaining height (and gives child elastic-y kids
  // somewhere to grow into). Used by Library so its file list can
  // expand when adjacent panels are collapsed.
  elastic?: boolean;
}

export function Section({
  title,
  icon,
  children,
  className,
  onClick,
  onTitleClick,
  elastic,
}: SectionProps) {
  return (
    <section
      onClick={onClick}
      className={cn(
        "rounded-xl bg-panel border border-surface/60 shadow-md",
        "p-4 flex flex-col gap-3",
        // min-h-0 lets a parent-flex layout shrink the section below
        // its content height when needed (e.g. when set to flex-1).
        elastic && "min-h-0",
        className,
      )}
    >
      <header
        onClick={onTitleClick}
        title={onTitleClick ? "Click the header to expand or collapse" : undefined}
        className={cn(
          "flex items-center gap-2 text-accent font-semibold",
          onTitleClick &&
            "-mx-2 px-2 py-1 rounded-md cursor-pointer select-none " +
              "bg-fg/5 shadow-inner transition-colors hover:bg-fg/10",
        )}
      >
        {icon}
        <h2 className="text-sm tracking-wide uppercase">{title}</h2>
      </header>
      <div
        className={cn(
          "text-sm text-fg/90",
          elastic && "flex-1 min-h-0 flex flex-col",
        )}
      >
        {children}
      </div>
    </section>
  );
}
