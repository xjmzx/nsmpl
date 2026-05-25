import { useEffect, useRef, useState } from "react";
import {
  Crop,
  Loader2,
  Pause,
  Play,
  Repeat,
  Scissors,
  Square,
  X,
} from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, {
  type Region,
} from "wavesurfer.js/dist/plugins/regions.esm.js";
import { Section } from "./Section";
import {
  pruneAudio,
  readAudioFile,
  trimAudio,
  type AudioFile,
  type AudioInfo,
} from "../lib/tauri";
import { cn } from "../lib/cn";

interface PlayerProps {
  file: AudioFile | null;
  onAudioInfo?: (info: AudioInfo | null) => void;
  // Fired with the absolute output path after a successful trim/prune
  // so the parent can refresh the file browser.
  onEdited?: (path: string) => void;
  // Optional label appended to "Track" in the header (e.g. "1", "2").
  // Omitted = bare "Track" title (single-player mode).
  label?: string;
  // Multi-track focus routing — `focused` highlights the card, and
  // clicking anywhere in it calls `onFocus` so the parent can re-route
  // FileBrowser clicks / Publish / InfoPanel to this track.
  focused?: boolean;
  onFocus?: () => void;
}

type EditMode = "trim" | "prune";
type EditStatus =
  | { kind: "ok"; mode: EditMode; path: string }
  | { kind: "err"; mode: EditMode; msg: string };

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
  return MIME_BY_EXT[ext] ?? "audio/*";
}

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtSecs(t: number): string {
  return `${t.toFixed(2)}s`;
}

const WAVE = "#6c7086";
const PROGRESS = "#89b4fa";
const CURSOR = "#cdd6f4";
const REGION_FILL = "rgba(137, 180, 250, 0.18)";

export function Player({
  file,
  onAudioInfo,
  onEdited,
  label,
  focused,
  onFocus,
}: PlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // All playback runs through WaveSurfer's HTMLMediaElement. We tried a
  // sample-accurate AudioBufferSourceNode + loop=true / loopStart /
  // loopEnd path for region loops, but on WebKit2GTK the audio thread
  // emits frames into the destination that never reach the sound card
  // (visible cursor motion, audible silence) regardless of keep-alive
  // tricks or user-gesture timing. HTMLMediaElement audio works
  // reliably on the same backend, so region loop is implemented as a
  // rAF-polled wrap on top of it. Trade-off: ~one rAF tick (~16ms) of
  // overshoot at the loop boundary plus the element's seek latency.
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const activeRegionRef = useRef<Region | null>(null);
  const loopRangeRef = useRef<{ start: number; end: number } | null>(null);
  const loopRafRef = useRef(0);
  const loopRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [regionRange, setRegionRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  // ---- edit (trim / prune) -----------------------------------------
  const [editBusy, setEditBusy] = useState<EditMode | null>(null);
  const [editStatus, setEditStatus] = useState<EditStatus | null>(null);

  // Reset edit feedback when the user switches samples.
  useEffect(() => {
    setEditStatus(null);
  }, [file?.path]);

  async function runEdit(mode: EditMode) {
    if (!file || !regionRange || editBusy) return;
    setEditBusy(mode);
    setEditStatus(null);
    try {
      const fn = mode === "trim" ? trimAudio : pruneAudio;
      const path = await fn(file.path, regionRange.start, regionRange.end);
      setEditStatus({ kind: "ok", mode, path });
      onEdited?.(path);
    } catch (e) {
      setEditStatus({ kind: "err", mode, msg: String(e) });
    } finally {
      setEditBusy(null);
    }
  }

  // ---- region loop watch (rAF-polled) -------------------------------
  function stopRegionLoopWatch() {
    if (loopRafRef.current) {
      cancelAnimationFrame(loopRafRef.current);
      loopRafRef.current = 0;
    }
    loopRangeRef.current = null;
  }

  function startRegionLoopWatch(start: number, end: number) {
    if (loopRafRef.current) cancelAnimationFrame(loopRafRef.current);
    loopRangeRef.current = { start, end };
    const tick = () => {
      const ws = wsRef.current;
      const range = loopRangeRef.current;
      if (!ws || !range) {
        loopRafRef.current = 0;
        return;
      }
      if (ws.getCurrentTime() >= range.end) {
        ws.setTime(range.start);
      }
      loopRafRef.current = requestAnimationFrame(tick);
    };
    loopRafRef.current = requestAnimationFrame(tick);
  }

  // If loop is toggled off mid-playback, drop the wrap watch but let
  // playback continue out to the end of the file.
  useEffect(() => {
    if (!loop) stopRegionLoopWatch();
  }, [loop]);

  // ---- WaveSurfer init / load ---------------------------------------
  useEffect(() => {
    let cancelled = false;

    setPlaying(false);
    setTime(0);
    setDuration(0);
    setRegionRange(null);
    setError(null);
    activeRegionRef.current = null;
    stopRegionLoopWatch();
    onAudioInfo?.(null);

    if (!file || !containerRef.current) return;

    setLoading(true);

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: WAVE,
      progressColor: PROGRESS,
      cursorColor: CURSOR,
      cursorWidth: 1,
      height: 80,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      plugins: [regions],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    ws.on("ready", () => {
      if (cancelled) return;
      setDuration(ws.getDuration());
      setLoading(false);
      regions.enableDragSelection({ color: REGION_FILL });
    });
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("timeupdate", (t: number) => setTime(t));
    ws.on("finish", () => {
      // Whole-file loop when no region is selected; if a region is set
      // and loop is on, the rAF watch should already have wrapped before
      // we got here, but guard just in case.
      if (!loopRef.current) return;
      const r = activeRegionRef.current;
      ws.setTime(r ? r.start : 0);
      void ws.play();
    });
    ws.on("error", (err: Error) => {
      setError(`waveform: ${String(err.message ?? err)}`);
      setLoading(false);
    });

    regions.on("region-created", (r: Region) => {
      regions.getRegions().forEach((other: Region) => {
        if (other.id !== r.id) other.remove();
      });
      activeRegionRef.current = r;
      setRegionRange({ start: r.start, end: r.end });
    });
    regions.on("region-updated", (r: Region) => {
      if (activeRegionRef.current?.id !== r.id) return;
      setRegionRange({ start: r.start, end: r.end });
      // Live-update the wrap bounds; the next rAF tick will catch the
      // cursor against the new range.
      if (loopRangeRef.current) {
        loopRangeRef.current = { start: r.start, end: r.end };
      }
    });
    regions.on("region-removed", (r: Region) => {
      if (activeRegionRef.current?.id === r.id) {
        activeRegionRef.current = null;
        setRegionRange(null);
        stopRegionLoopWatch();
      }
    });

    readAudioFile(file.path)
      .then((buffer) => {
        if (cancelled) return;

        // Metadata-only decode in an OfflineAudioContext: no audio
        // output, so no autoplay implications, and we still get
        // sampleRate / channels / duration for the InfoPanel.
        const meta = new OfflineAudioContext(1, 1, 44100);
        void meta.decodeAudioData(buffer.slice(0))
          .then((b) => {
            if (cancelled) return;
            onAudioInfo?.({
              sampleRate: b.sampleRate,
              channels: b.numberOfChannels,
              duration: b.duration,
            });
          })
          .catch(() => { /* metadata unavailable */ });

        const blob = new Blob([buffer], { type: mimeFor(file.name) });
        return ws.loadBlob(blob);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(`read failed: ${String(e)}`);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      stopRegionLoopWatch();
      ws.destroy();
      if (wsRef.current === ws) wsRef.current = null;
      if (regionsRef.current === regions) regionsRef.current = null;
    };
  }, [file?.path, file?.name]);

  // ---- transport ---------------------------------------------------
  function play() {
    const ws = wsRef.current;
    const r = activeRegionRef.current;
    if (!ws) return;

    if (loop && r) {
      // Region loop: seek to start, kick playback, install wrap watch.
      if (ws.getCurrentTime() < r.start || ws.getCurrentTime() >= r.end) {
        ws.setTime(r.start);
      }
      startRegionLoopWatch(r.start, r.end);
      void ws.play().catch((e: unknown) => setError(String(e)));
      return;
    }

    // Plain playback (whole file, with or without whole-file loop).
    if (r && (ws.getCurrentTime() < r.start || ws.getCurrentTime() >= r.end)) {
      ws.setTime(r.start);
    }
    void ws.play().catch((e: unknown) => setError(String(e)));
  }

  function pause() {
    stopRegionLoopWatch();
    wsRef.current?.pause();
  }

  function stop() {
    stopRegionLoopWatch();
    const ws = wsRef.current;
    if (!ws) return;
    ws.pause();
    ws.setTime(activeRegionRef.current?.start ?? 0);
  }

  function toggleLoop() {
    setLoop((p) => !p);
  }

  function clearRegion() {
    regionsRef.current?.clearRegions();
  }

  const editReady = !!file && !!regionRange && regionRange.end > regionRange.start;
  const editDisabled = !editReady || editBusy !== null;

  const title = label ? `Track ${label}` : "Track";

  return (
    <Section
      title={title}
      icon={<Play size={16} />}
      onClick={onFocus}
      className={cn(
        onFocus && "cursor-pointer",
        focused && "ring-2 ring-accent/40",
      )}
    >
      <div className="text-xs text-muted truncate">
        {file ? file.name : "No sample loaded"}
      </div>

      <div className="space-y-1">
        <div
          ref={containerRef}
          className="rounded-md bg-bg/50 px-2 py-2 min-h-[96px]"
        />
        <div className="flex justify-between text-[10px] text-muted font-mono">
          <span>{fmt(time)}</span>
          <span>
            {loading
              ? "loading…"
              : file
                ? "click to seek · drag to set loop region"
                : "select a sample"}
          </span>
          <span>{fmt(duration)}</span>
        </div>
      </div>

      {error && (
        <pre className="text-xs text-alert font-mono break-all whitespace-pre-wrap">
          {error}
        </pre>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={playing ? pause : play}
          disabled={!file || loading}
          className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                     disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center gap-1.5 text-fg"
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
          {playing ? "Pause" : "Play"}
        </button>
        <button
          onClick={stop}
          disabled={!file || loading}
          className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                     disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center gap-1.5 text-fg"
        >
          <Square size={14} /> Stop
        </button>

        <button
          onClick={() => runEdit("trim")}
          disabled={editDisabled}
          title={
            editBusy === "trim"
              ? "Trimming…"
              : !file
                ? "Load a sample first"
                : !regionRange
                  ? "Drag a loop region first"
                  : `Trim to ${fmtSecs(regionRange.start)} → ${fmtSecs(regionRange.end)} (saves next to source)`
          }
          className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                     disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center gap-1.5 text-fg"
        >
          {editBusy === "trim" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Crop size={14} />
          )}
          Trim
        </button>
        <button
          onClick={() => runEdit("prune")}
          disabled={editDisabled}
          title={
            editBusy === "prune"
              ? "Pruning…"
              : !file
                ? "Load a sample first"
                : !regionRange
                  ? "Drag a loop region first"
                  : `Delete ${fmtSecs(regionRange.start)} → ${fmtSecs(regionRange.end)} and save the remainder next to source`
          }
          className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                     disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center gap-1.5 text-fg"
        >
          {editBusy === "prune" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Scissors size={14} />
          )}
          Prune
        </button>

        {regionRange && (
          <div
            className="ml-2 px-2 py-1 rounded-md bg-bg/50 text-[10px] font-mono
                       text-fg/80 flex items-center gap-1.5"
            title="active loop region"
          >
            <span className="text-muted">region</span>
            <span>{fmtSecs(regionRange.start)}</span>
            <span className="text-muted">→</span>
            <span>{fmtSecs(regionRange.end)}</span>
            <span className="text-muted">
              ({fmtSecs(regionRange.end - regionRange.start)})
            </span>
            <button
              onClick={clearRegion}
              className="ml-1 text-muted hover:text-alert"
              title="Clear region"
            >
              <X size={11} />
            </button>
          </div>
        )}

        <button
          onClick={toggleLoop}
          disabled={!file || loading}
          className={cn(
            "ml-auto px-3 py-2 rounded-md flex items-center gap-1.5",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            loop
              ? "bg-accent/20 text-accent"
              : "bg-surface hover:bg-surfaceHover text-fg",
          )}
          title={
            regionRange
              ? "Loop the selected region"
              : "Loop the whole file"
          }
        >
          <Repeat size={14} /> Loop
        </button>
      </div>

      {editStatus?.kind === "ok" && (
        <p className="text-xs text-ok font-mono break-all">
          wrote {editStatus.path}
        </p>
      )}
      {editStatus?.kind === "err" && (
        <pre className="text-xs text-alert font-mono break-all whitespace-pre-wrap">
          {editStatus.msg}
        </pre>
      )}
    </Section>
  );
}
