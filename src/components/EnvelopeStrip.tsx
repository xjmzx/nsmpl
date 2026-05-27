import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

/// Non-destructive fade-in / fade-out envelope strip.
///
/// Renders as a thin track above the waveform — left-edge ramp shows
/// the fade-in shape (rising), right-edge ramp shows the fade-out
/// shape (falling). Each ramp's inner endpoint is a draggable circular
/// handle: drag inward to lengthen the fade, drag back to the wave
/// edge to zero it. Combined fades are clamped so fadeIn + fadeOut
/// never exceeds the audible duration.
///
/// The strip is intentionally positioned *outside* the wave canvas so
/// it can't compete with the loop-region selection chrome.
interface EnvelopeStripProps {
  /// Audible duration the envelope applies to — when a loop region is
  /// set, this is the region length (so fades match what bounce will
  /// produce); when no region, the full file duration.
  duration: number;
  fadeInSec: number;
  fadeOutSec: number;
  onFadeInChange: (sec: number) => void;
  onFadeOutChange: (sec: number) => void;
  disabled?: boolean;
}

const STRIP_HEIGHT_PX = 18;
const HANDLE_RADIUS_PX = 6;

export function EnvelopeStrip({
  duration,
  fadeInSec,
  fadeOutSec,
  onFadeInChange,
  onFadeOutChange,
  disabled = false,
}: EnvelopeStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  // Track which handle (if any) is being dragged so the pointer-move
  // handler — bound to the window so it survives the pointer leaving
  // the handle's hitbox — knows which fade value to update.
  const dragRef = useRef<"in" | "out" | null>(null);
  const startStateRef = useRef<{ x: number; sec: number }>({ x: 0, sec: 0 });
  const [hovered, setHovered] = useState<"in" | "out" | null>(null);

  // Defensive: if the duration is unknown (file still decoding) or
  // tiny, we render the empty strip so the layout doesn't jump but
  // disable interaction.
  const usable = duration > 0.05 && !disabled;

  const secPerPx = useCallback(() => {
    const w = stripRef.current?.clientWidth ?? 1;
    return duration / Math.max(w, 1);
  }, [duration]);

  // Clamp helper — keeps fadeIn + fadeOut ≤ duration so the two ramps
  // can never visually overlap (or fight each other audibly).
  const clampPair = useCallback(
    (which: "in" | "out", next: number) => {
      const minSec = 0;
      // Reserve a hair so the handles never sit exactly on top of
      // each other when fully extended.
      const headroom = 0.001;
      if (which === "in") {
        const max = Math.max(0, duration - fadeOutSec - headroom);
        return Math.max(minSec, Math.min(next, max));
      }
      const max = Math.max(0, duration - fadeInSec - headroom);
      return Math.max(minSec, Math.min(next, max));
    },
    [duration, fadeInSec, fadeOutSec],
  );

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const which = dragRef.current;
      if (!which) return;
      const dx = e.clientX - startStateRef.current.x;
      const delta = dx * secPerPx();
      // For fade-in, dragging RIGHT grows the fade. For fade-out,
      // dragging LEFT grows the fade — invert the delta.
      const raw =
        which === "in"
          ? startStateRef.current.sec + delta
          : startStateRef.current.sec - delta;
      const next = clampPair(which, raw);
      if (which === "in") onFadeInChange(next);
      else onFadeOutChange(next);
    }
    function onUp() {
      dragRef.current = null;
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [secPerPx, clampPair, onFadeInChange, onFadeOutChange]);

  function startDrag(which: "in" | "out", e: React.PointerEvent) {
    if (!usable) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = which;
    startStateRef.current = {
      x: e.clientX,
      sec: which === "in" ? fadeInSec : fadeOutSec,
    };
    // Lock text-selection while dragging so the cursor stays clean.
    document.body.style.userSelect = "none";
  }

  // Convert seconds → percentage of strip width for visual placement.
  const fadeInPct = duration > 0 ? (fadeInSec / duration) * 100 : 0;
  const fadeOutPct = duration > 0 ? (fadeOutSec / duration) * 100 : 0;

  return (
    <div
      ref={stripRef}
      className={cn(
        "relative w-full overflow-hidden rounded-sm",
        "bg-bg/30 border border-surface/40",
        !usable && "opacity-40",
      )}
      style={{ height: STRIP_HEIGHT_PX }}
      title={
        usable
          ? "Drag handles inward to set fade-in / fade-out — non-destructive, baked at bounce"
          : "Envelope strip — load a sample to enable"
      }
    >
      {/* Left ramp — visual triangle representing the fade-in curve.
          Uses clip-path so the gradient fills the triangular wedge
          rather than a rectangle. */}
      {fadeInSec > 0 && (
        <div
          className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-accent/5 to-accent/40"
          style={{
            width: `${fadeInPct}%`,
            clipPath: "polygon(0 100%, 100% 0, 100% 100%)",
          }}
        />
      )}
      {/* Right ramp — mirror of left. */}
      {fadeOutSec > 0 && (
        <div
          className="absolute top-0 bottom-0 right-0 bg-gradient-to-l from-accent/5 to-accent/40"
          style={{
            width: `${fadeOutPct}%`,
            clipPath: "polygon(0 0, 100% 100%, 0 100%)",
          }}
        />
      )}

      {/* Left handle. Sits at the inner end of the fade-in ramp; when
          fade is 0 it lives at x=0 (the wave's left edge). */}
      <button
        type="button"
        aria-label="Fade-in handle — drag right to lengthen"
        title={`fade-in: ${fadeInSec.toFixed(2)}s`}
        disabled={!usable}
        onPointerDown={(e) => startDrag("in", e)}
        onPointerEnter={() => setHovered("in")}
        onPointerLeave={() => setHovered(null)}
        className={cn(
          "absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full",
          "transition-colors border border-accent/60",
          usable ? "cursor-ew-resize" : "cursor-not-allowed",
          hovered === "in" || dragRef.current === "in"
            ? "bg-accent"
            : "bg-accent/70",
        )}
        style={{
          left: `${fadeInPct}%`,
          width: HANDLE_RADIUS_PX * 2,
          height: HANDLE_RADIUS_PX * 2,
        }}
      />

      {/* Right handle — symmetric. */}
      <button
        type="button"
        aria-label="Fade-out handle — drag left to lengthen"
        title={`fade-out: ${fadeOutSec.toFixed(2)}s`}
        disabled={!usable}
        onPointerDown={(e) => startDrag("out", e)}
        onPointerEnter={() => setHovered("out")}
        onPointerLeave={() => setHovered(null)}
        className={cn(
          "absolute top-1/2 -translate-y-1/2 translate-x-1/2 rounded-full",
          "transition-colors border border-accent/60",
          usable ? "cursor-ew-resize" : "cursor-not-allowed",
          hovered === "out" || dragRef.current === "out"
            ? "bg-accent"
            : "bg-accent/70",
        )}
        style={{
          right: `${fadeOutPct}%`,
          width: HANDLE_RADIUS_PX * 2,
          height: HANDLE_RADIUS_PX * 2,
        }}
      />
    </div>
  );
}
