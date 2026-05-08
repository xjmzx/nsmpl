import { ReactNode } from "react";
import { cn } from "../lib/cn";

interface SectionProps {
  title: string;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Section({ title, icon, children, className }: SectionProps) {
  return (
    <section
      className={cn(
        "rounded-xl bg-panel border border-surface/60 shadow-md",
        "p-4 flex flex-col gap-3",
        className,
      )}
    >
      <header className="flex items-center gap-2 text-accent font-semibold">
        {icon}
        <h2 className="text-sm tracking-wide uppercase">{title}</h2>
      </header>
      <div className="text-sm text-fg/90">{children}</div>
    </section>
  );
}
