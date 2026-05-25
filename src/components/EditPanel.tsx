import { useState } from "react";
import { Crop, Loader2 } from "lucide-react";
import { Section } from "./Section";
import { trimAudio, type AudioFile } from "../lib/tauri";

interface EditPanelProps {
  file: AudioFile | null;
  region: { start: number; end: number } | null;
  // Fired with the absolute output path after a successful trim, so the
  // parent can refresh the file browser to surface the new file.
  onTrimmed?: (path: string) => void;
}

function fmt(t: number): string {
  return `${t.toFixed(2)}s`;
}

type Status = { kind: "ok"; path: string } | { kind: "err"; msg: string };

export function EditPanel({ file, region, onTrimmed }: EditPanelProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const length = region ? region.end - region.start : 0;
  const ready = !!file && !!region && length > 0;

  async function onTrim() {
    if (!ready || !file || !region) return;
    setBusy(true);
    setStatus(null);
    try {
      const path = await trimAudio(file.path, region.start, region.end);
      setStatus({ kind: "ok", path });
      onTrimmed?.(path);
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setBusy(false);
    }
  }

  const buttonTitle = busy
    ? "Trimming…"
    : !file
      ? "Load a sample first"
      : !region
        ? "Drag a loop region on the waveform to set the trim range"
        : `Trim ${fmt(region.start)} → ${fmt(region.end)} (${fmt(length)}) and save next to source`;

  return (
    <Section title="Edit" icon={<Crop size={16} />}>
      <p className="text-xs text-muted">
        Trim the loaded sample to the loop range. Stream-copy via ffmpeg
        (sample-accurate on WAV/AIFF, frame-accurate on FLAC,
        near-packet-boundary on lossy formats). Saves next to the source
        as <span className="font-mono">…-trim.ext</span>.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={onTrim}
          disabled={!ready || busy}
          title={buttonTitle}
          className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                     text-fg flex items-center justify-center gap-1.5
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Crop size={14} />
          )}
          {busy ? "Trimming…" : "Trim to region"}
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
