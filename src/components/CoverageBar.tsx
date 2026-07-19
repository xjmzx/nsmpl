import { cn } from "../lib/cn";
import type { ClipCoverage } from "../lib/tauri";

// `h:mm:ss` past an hour, else `m:ss`.
function fmtDur(secs: number): string {
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toString().padStart(2, "0");
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// Sub-minute clip lengths read as "10s"; longer as m:ss.
function fmtClip(secs: number): string {
  return secs < 60 ? `${Math.round(secs)}s` : fmtDur(secs);
}

// Perceptual (sqrt) fill so a small clip fraction still registers — a 10s clip
// of a 4-min track (~4%) shows as a visible ~20% bar. 0→empty, 1→full,
// monotonic; a floor keeps a present clip from vanishing. Mirrors ntree's
// library bar. Deliberately representative, not true-to-scale.
function barWidth(frac: number): string {
  const w = Math.min(Math.max(Math.sqrt(frac), 0.04), 1);
  return `${Math.round(w * 100)}%`;
}

/** Per-clip coverage bar: this clip's probed length as a fraction of its
 *  resolved source track. Because nsmpl probes the clip's OWN length, this
 *  handles variable-length clips (5–60s) natively. Empty when the source
 *  didn't resolve (drift / not mirrored) or nothing was probed yet. */
export function ClipBar({ cov }: { cov: ClipCoverage | undefined }) {
  const clip = cov?.clipSecs ?? null;
  const source = cov?.sourceSecs ?? null;
  if (!clip || !source || source <= 0) {
    return (
      <span
        className="flex items-center"
        title={
          clip && !source
            ? `${fmtClip(clip)} clip · source not resolved`
            : "No coverage"
        }
      >
        <span className="flex-1 h-1.5 rounded-full bg-surface/40" />
      </span>
    );
  }
  const frac = Math.min(clip, source) / source;
  return (
    <span
      className="flex items-center"
      title={`${fmtClip(clip)} clip of ${fmtDur(source)}`}
    >
      <span className="relative flex-1 h-1.5 rounded-full bg-surface/60 overflow-hidden">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full bg-ok")}
          style={{ width: barWidth(frac) }}
        />
      </span>
    </span>
  );
}

/** Aggregate coverage for the open folder: Σ clip ÷ Σ source over the clips
 *  that resolved. Rendered in the file-list header (the open-folder rollup). */
export function CoverageBar({ rows }: { rows: ClipCoverage[] }) {
  let clip = 0;
  let source = 0;
  for (const c of rows) {
    if (c.clipSecs && c.sourceSecs && c.sourceSecs > 0) {
      clip += Math.min(c.clipSecs, c.sourceSecs);
      source += c.sourceSecs;
    }
  }
  if (source <= 0) return null;
  return (
    <span
      className="flex items-center"
      title={`Clip coverage · ${fmtDur(clip)} sampled of ${fmtDur(source)}`}
    >
      <span className="relative flex-1 h-1 rounded-full bg-surface/60 overflow-hidden">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-ok/80"
          style={{ width: barWidth(clip / source) }}
        />
      </span>
    </span>
  );
}
