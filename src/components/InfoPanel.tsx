import { Info } from "lucide-react";
import { Section } from "./Section";
import type { AudioFile, AudioInfo } from "../lib/tauri";
import { cn } from "../lib/cn";

const MIME_BY_EXT: Record<string, string> = {
  wav: "audio/wav",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  wv: "audio/x-wavpack",
};

function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtDate(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function fmtDuration(s: number): string {
  if (!isFinite(s) || s <= 0) return "—";
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

interface InfoPanelProps {
  file: AudioFile | null;
  audioInfo: AudioInfo | null;
}

export function InfoPanel({ file, audioInfo }: InfoPanelProps) {
  const mime = file ? mimeFor(file.name) : null;

  return (
    <Section title="Sample" icon={<Info size={16} />} className="h-full">
      {!file ? (
        <p className="text-xs text-muted">Select a sample on the left.</p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          <Row label="name" value={file.name} mono />
          <Row label="path" value={file.path} mono truncate />
          <Row label="size" value={fmtSize(file.size)} />
          <Row label="modified" value={fmtDate(file.modified)} />
          <Row label="mime" value={mime ?? "—"} mono />
          {audioInfo ? (
            <>
              <Row
                label="rate"
                value={`${(audioInfo.sampleRate / 1000).toFixed(1)} kHz`}
              />
              <Row
                label="channels"
                value={
                  audioInfo.channels === 1
                    ? "mono"
                    : audioInfo.channels === 2
                      ? "stereo"
                      : `${audioInfo.channels}-ch`
                }
              />
              <Row label="duration" value={fmtDuration(audioInfo.duration)} />
            </>
          ) : (
            <Row label="audio" value="decoding…" muted />
          )}
        </dl>
      )}
    </Section>
  );
}

function Row({
  label,
  value,
  mono,
  truncate,
  muted,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
  muted?: boolean;
}) {
  return (
    <>
      <dt className="text-muted text-[10px] uppercase tracking-wide">
        {label}
      </dt>
      <dd
        className={cn(
          mono && "font-mono",
          truncate && "truncate",
          muted ? "text-muted italic" : "text-fg/90",
        )}
        title={value}
      >
        {value}
      </dd>
    </>
  );
}
