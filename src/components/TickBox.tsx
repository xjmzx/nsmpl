import { Check } from "lucide-react";

// A themed checkbox. The native control is drawn by the platform — on Linux
// (WebKitGTK) that is the desktop's own accent-coloured box, oversized for a
// 10px label and with its tick clipped — so the box is ours: a rounded square
// in the same surface/border family as the field chips beside it, with the
// tick as an icon on top. The real <input> stays, for keyboard and a11y.
export function TickBox({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <span className="relative shrink-0 grid place-items-center w-3.5 h-3.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
        className="peer appearance-none m-0 w-3.5 h-3.5 rounded-[3px] cursor-pointer
                   border border-muted/40 bg-surface/40 transition-colors
                   hover:border-accent/50 checked:border-accent/70
                   checked:bg-accent/15 focus-visible:outline
                   focus-visible:outline-1 focus-visible:outline-accent"
      />
      <Check
        size={10}
        strokeWidth={3}
        className="pointer-events-none absolute text-accent opacity-0
                   peer-checked:opacity-100"
      />
    </span>
  );
}
