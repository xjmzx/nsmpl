import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { Section } from "./Section";
import { CollapsedStrip } from "./CollapsedStrip";
import {
  resolveSource,
  type AudioFile,
  type AudioInfo,
  type SourceResolution,
} from "../lib/tauri";
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

function fmtChannels(n: number): string {
  if (n === 1) return "mono";
  if (n === 2) return "stereo";
  return `${n}-ch`;
}

// Express a file path relative to a root directory, as { root, rel } where
// `root` is the root's basename (its de-facto name) and `rel` is the path
// beneath it. Returns null when the file isn't under the root. This is the
// first, single-root version of the suite's (named root, relpath) identity —
// the loaded library dir stands in as the root until a roots manifest lands.
function relUnderRoot(
  root: string,
  full: string,
): { root: string; rel: string } | null {
  if (!root || !full) return null;
  const norm = root.replace(/\/+$/, "");
  if (!full.startsWith(norm + "/")) return null;
  const rel = full.slice(norm.length + 1);
  const name = norm.split("/").pop() || norm;
  return { root: name, rel };
}

interface InfoPanelProps {
  file: AudioFile | null;
  audioInfo: AudioInfo | null;
  // The loaded library directory — the de-facto root for relative-path display.
  rootDir?: string;
  // Horizontal collapse: when true the panel renders as a thin strip and the
  // flank's width is reclaimed for the Library (state owned by App).
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function InfoPanel({
  file,
  audioInfo,
  rootDir,
  collapsed,
  onToggleCollapsed,
}: InfoPanelProps) {
  // Manifest-based resolution (named root + clip→source track). Resolved in
  // Rust against ~/.config/ndisc-suite/roots.json; null while pending or when
  // the manifest is absent, in which case we fall back to the de-facto root
  // (the loaded library dir basename) below.
  const [resolution, setResolution] = useState<SourceResolution | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!file) {
      setResolution(null);
      return;
    }
    resolveSource(file.path)
      .then((r) => !cancelled && setResolution(r))
      .catch(() => !cancelled && setResolution(null));
    return () => {
      cancelled = true;
    };
  }, [file?.path]);

  const mime = file ? mimeFor(file.name) : null;
  const fallback = file ? relUnderRoot(rootDir ?? "", file.path) : null;
  // Prefer the manifest's named root; fall back to the loaded-dir basename.
  const rootName = resolution?.root ?? fallback?.root ?? null;
  const relPath = resolution?.rel ?? fallback?.rel ?? null;
  const sourceTrack = resolution?.sourcePath ?? null;
  const sourceName = sourceTrack
    ? sourceTrack.split("/").pop() || sourceTrack
    : null;

  if (collapsed) {
    return (
      <CollapsedStrip
        label="Sample"
        icon={<Info size={16} />}
        side="left"
        onExpand={() => onToggleCollapsed?.()}
        className="border-accent/30"
      />
    );
  }

  return (
    <Section
      title="Sample"
      icon={<Info size={16} />}
      onTitleClick={onToggleCollapsed}
      className="border-accent/30"
    >
      {!file ? (
        <p className="text-xs text-muted">Select a sample on the left.</p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          <Row label="name" value={file.name} mono />
          {rootName && relPath != null && (
            <>
              <dt className="text-muted text-[10px] uppercase tracking-wide">
                source
              </dt>
              <dd
                className="font-mono truncate"
                title={`${rootName}/${relPath}`}
              >
                <span className="text-accent">{rootName}</span>
                <span className="text-muted">/</span>
                <span className="text-fg/90">{relPath}</span>
              </dd>
            </>
          )}
          {sourceTrack && (
            <>
              <dt className="text-muted text-[10px] uppercase tracking-wide">
                from
              </dt>
              <dd className="font-mono truncate" title={sourceTrack}>
                <span className={resolution?.sourceExists ? "text-ok" : "text-alert"}>
                  {resolution?.sourceExists ? "⟵ " : "⚠ "}
                </span>
                <span className="text-fg/90">{sourceName}</span>
              </dd>
            </>
          )}
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
              <Row label="channels" value={fmtChannels(audioInfo.channels)} />
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
