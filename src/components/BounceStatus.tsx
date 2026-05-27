import { Check, Loader2, X } from "lucide-react";
import { cn } from "../lib/cn";

/// Snapshot of the master bounce's lifecycle, with elapsed time
/// inlined for the running state so the consumer doesn't need to read
/// a separate ticker. `idle` renders nothing.
export type BounceView =
  | { status: "idle" }
  | { status: "running"; elapsedMs: number }
  | { status: "done"; path: string }
  | { status: "failed"; error: string };

/// Inline status line for the bounce operation. Visible only when
/// `view.status !== "idle"`. Tones: auburn for running (matches the
/// Bounce button), ok for done, alert for failed.
export function BounceStatus({
  view,
  align = "left",
}: {
  view: BounceView;
  align?: "left" | "right";
}) {
  if (view.status === "idle") return null;
  const base =
    "text-[10px] font-mono inline-flex items-center gap-1 max-w-[16rem]";
  const justify = align === "right" ? "justify-end" : "justify-start";

  if (view.status === "running") {
    return (
      <span className={cn(base, justify, "text-auburn")}>
        <Loader2 size={10} className="animate-spin" />
        <span>rendering… {(view.elapsedMs / 1000).toFixed(1)}s</span>
      </span>
    );
  }

  if (view.status === "done") {
    const name = view.path.split("/").pop() ?? view.path;
    return (
      <span
        className={cn(base, justify, "text-ok")}
        title={view.path}
      >
        <Check size={10} />
        <span className="truncate">saved: {name}</span>
      </span>
    );
  }

  return (
    <span
      className={cn(base, justify, "text-alert")}
      title={view.error}
    >
      <X size={10} />
      <span className="truncate">{view.error}</span>
    </span>
  );
}
