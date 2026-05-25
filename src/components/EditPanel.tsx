import { useState } from "react";
import { Crop, Loader2, Scissors, Wand2 } from "lucide-react";
import { Section } from "./Section";
import { pruneAudio, trimAudio, type AudioFile } from "../lib/tauri";

interface EditPanelProps {
  file: AudioFile | null;
  region: { start: number; end: number } | null;
  // Fired with the absolute output path after a successful edit, so the
  // parent can refresh the file browser to surface the new file.
  onEdited?: (path: string) => void;
}

function fmt(t: number): string {
  return `${t.toFixed(2)}s`;
}

type Mode = "trim" | "prune";
type Status =
  | { kind: "ok"; mode: Mode; path: string }
  | { kind: "err"; mode: Mode; msg: string };

export function EditPanel({ file, region, onEdited }: EditPanelProps) {
  const [busy, setBusy] = useState<Mode | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  const length = region ? region.end - region.start : 0;
  const ready = !!file && !!region && length > 0;

  async function run(mode: Mode) {
    if (!ready || !file || !region) return;
    setBusy(mode);
    setStatus(null);
    try {
      const fn = mode === "trim" ? trimAudio : pruneAudio;
      const path = await fn(file.path, region.start, region.end);
      setStatus({ kind: "ok", mode, path });
      onEdited?.(path);
    } catch (e) {
      setStatus({ kind: "err", mode, msg: String(e) });
    } finally {
      setBusy(null);
    }
  }

  function titleFor(mode: Mode): string {
    if (busy === mode) return mode === "trim" ? "Trimming…" : "Pruning…";
    if (!file) return "Load a sample first";
    if (!region) return "Drag a loop region on the waveform first";
    if (mode === "trim") {
      return `Keep ${fmt(region.start)} → ${fmt(region.end)} (${fmt(length)}) and save next to source`;
    }
    return `Delete ${fmt(region.start)} → ${fmt(region.end)} (${fmt(length)}) and save the remainder next to source`;
  }

  return (
    <Section title="Edit" icon={<Wand2 size={16} />}>
      <p className="text-xs text-muted">
        Trim to the loop region, or delete the loop region (keep the rest).
        Stream-copy via ffmpeg — sample-accurate on WAV/AIFF, frame-accurate
        on FLAC, near-packet-boundary on lossy. Saves next to the source.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => run("trim")}
          disabled={!ready || busy !== null}
          title={titleFor("trim")}
          className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                     text-fg flex items-center justify-center gap-1.5
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy === "trim" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Crop size={14} />
          )}
          {busy === "trim" ? "Trimming…" : "Trim to region"}
        </button>
        <button
          onClick={() => run("prune")}
          disabled={!ready || busy !== null}
          title={titleFor("prune")}
          className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                     text-fg flex items-center justify-center gap-1.5
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy === "prune" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Scissors size={14} />
          )}
          {busy === "prune" ? "Pruning…" : "Delete region"}
        </button>

        {region && (
          <span className="text-[10px] text-muted font-mono">
            {fmt(region.start)} → {fmt(region.end)} ({fmt(length)})
          </span>
        )}
      </div>

      {status?.kind === "ok" && (
        <p className="text-xs text-ok font-mono break-all">
          wrote {status.path}
        </p>
      )}
      {status?.kind === "err" && (
        <pre className="text-xs text-alert font-mono break-all whitespace-pre-wrap">
          {status.msg}
        </pre>
      )}
    </Section>
  );
}
