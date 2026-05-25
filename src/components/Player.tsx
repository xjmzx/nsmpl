import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  ChevronRight,
  Crop,
  Gauge,
  Loader2,
  Pause,
  Play,
  Repeat,
  Scissors,
  SkipBack,
  Split,
  Square,
  TrendingDown,
  TrendingUp,
  Volume2,
  X,
} from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, {
  type Region,
} from "wavesurfer.js/dist/plugins/regions.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import { Section } from "./Section";
import {
  detectBpm,
  fadeInAudio,
  fadeOutAudio,
  fadeTailAudio,
  gainAudio,
  padAtAudio,
  padEndAudio,
  padStartAudio,
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
  // Notifies the parent whenever this track's playing state flips,
  // so the master between-tracks strip can show play vs. pause based
  // on aggregate state across both decks.
  onPlayingChange?: (playing: boolean) => void;
  // Optional label appended to "Track" in the header (e.g. "1", "2").
  // Omitted = bare "Track" title (single-player mode).
  label?: string;
  // Multi-track focus routing — `focused` highlights the card, and
  // clicking anywhere in it calls `onFocus` so the parent can re-route
  // FileBrowser clicks / Publish / InfoPanel to this track.
  focused?: boolean;
  onFocus?: () => void;
  // UI density. "slim" (default) saves vertical space on small monitors;
  // "wide" matches the original layout with a separate filename row
  // and taller waveform/buttons.
  density?: "slim" | "wide";
  // Show the destructive-edits row (Trim/Prune/Gain/Fade). Default
  // collapsed — the deck-first UX keeps transport prominent and edits
  // out of the way.
  editsExpanded?: boolean;
  // Whole-track collapse. When false, only the title row renders so
  // the deck pair can shrink down to two compact lines + master strip.
  expanded?: boolean;
  onToggleExpand?: () => void;
}

// Density-dependent classNames + waveform pixel height. Slim is the
// installed default; wide reverts to the pre-slim layout.
const DENSITY = {
  slim: {
    waveHeight: 56,
    // Container holds the waveform (56px) + Timeline ruler (~14px) +
    // py-1.5 padding (12px) → ~82px content. min-h gives the box a
    // stable size before the wave decodes.
    waveContainer: "rounded-md bg-bg/50 px-2 py-1.5 min-h-[90px]",
    section: "p-3 gap-2",
    btn: "px-2.5 py-1.5 text-xs",
  },
  wide: {
    waveHeight: 80,
    waveContainer: "rounded-md bg-bg/50 px-2 py-2 min-h-[114px]",
    section: "", // Section defaults (p-4 gap-3) apply.
    btn: "px-3 py-2",
  },
} as const;

type EditMode =
  | "trim"
  | "prune"
  | "gain"
  | "fadein"
  | "fadeout"
  | "fadetail"
  | "padstart"
  | "padend"
  | "padmid";

/// Imperative handle exposed to App for the "master" between-tracks
/// strip. Each fans out to one Player; the bare audio path already
/// supports two HTMLMediaElements playing simultaneously (the OS
/// mixer combines them at the speakers).
export type PlayerHandle = {
  play: () => void;
  pause: () => void;
  stop: () => void;
  cue: () => void;
};
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
  if (!isFinite(t) || t < 0) return "0:00.000";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  // padStart(6, "0") ensures the seconds slot is SS.mmm so sub-10s
  // values still render as 0X.YYY rather than X.YYY.
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

function fmtSecs(t: number): string {
  return `${t.toFixed(3)}s`;
}

const WAVE = "#6c7086";
const PROGRESS = "#89b4fa";
const CURSOR = "#cdd6f4";
const REGION_FILL = "rgba(137, 180, 250, 0.18)";

// Three-tier grid stacked via multiple background-images. Major
// (brightest) ticks read at a glance; minor (faintest) give
// fine subdivision. Tiers adapt to duration so short clips get
// sub-second detail and long clips don't turn into a wall.
//
// 1 ms steps are pixel-impossible at any normal zoom (≪1px/ms);
// 100 ms is the floor for the finest visible tier.
type GridTier = { interval: number; opacity: number };
function gridTiersFor(duration: number): GridTier[] {
  if (duration <= 0) return [];
  if (duration < 5) {
    return [
      { interval: 1, opacity: 0.7 },
      { interval: 0.5, opacity: 0.35 },
      { interval: 0.1, opacity: 0.15 },
    ];
  }
  if (duration < 30) {
    return [
      { interval: 5, opacity: 0.7 },
      { interval: 1, opacity: 0.35 },
      { interval: 0.5, opacity: 0.15 },
    ];
  }
  if (duration < 120) {
    return [
      { interval: 10, opacity: 0.7 },
      { interval: 5, opacity: 0.35 },
      { interval: 1, opacity: 0.15 },
    ];
  }
  return [
    { interval: 60, opacity: 0.7 },
    { interval: 10, opacity: 0.35 },
    { interval: 5, opacity: 0.15 },
  ];
}
function gridGradient(duration: number): string {
  const tiers = gridTiersFor(duration);
  if (tiers.length === 0) return "none";
  // First listed = topmost in CSS painting order; major tier sits
  // on top so it doesn't get washed out by the finer layers.
  return tiers
    .map((t) => {
      const segments = Math.max(1, Math.round(duration / t.interval));
      const pct = 100 / segments;
      return (
        `repeating-linear-gradient(to right, ` +
        `rgba(108, 112, 134, ${t.opacity}) 0, ` +
        `rgba(108, 112, 134, ${t.opacity}) 1px, ` +
        `transparent 1px, transparent ${pct}%)`
      );
    })
    .join(", ");
}

// Min sample / region length aubio gets a fair shot at — anything
// shorter is just a hit, not a beat pattern.
const BPM_MIN_DURATION = 5; // seconds

// Master switch for the BPM-detection chip. Flip to true to wake the
// click handler; left disabled while the median-of-intervals math is
// too octave-confused on most real-world samples (see memory:
// project_smpl_audio_backlog). Chip stays visible as a placeholder so
// the feature isn't lost from view.
const BPM_DETECTION_ENABLED = false;

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(
  {
    file,
    onAudioInfo,
    onEdited,
    onPlayingChange,
    label,
    focused,
    onFocus,
    density = "slim",
    editsExpanded = false,
    expanded = true,
    onToggleExpand,
  },
  ref,
) {
  const D = DENSITY[density];
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

  // Bubble playing flips to the parent. Ref-piped so an unstable
  // parent callback doesn't re-fire the effect.
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;
  useEffect(() => {
    onPlayingChangeRef.current?.(playing);
  }, [playing]);

  // ---- edit (trim / prune / gain) ---------------------------------
  const [editBusy, setEditBusy] = useState<EditMode | null>(null);
  const [editStatus, setEditStatus] = useState<EditStatus | null>(null);
  // dB value the user wants to apply on the next "Gain" click.
  const [gainDb, setGainDb] = useState(0);
  // Shared fade duration (seconds) for both fade-in and fade-out.
  const [fadeDur, setFadeDur] = useState(1.0);
  // Shared pad duration (seconds) for start/end/at-region inserts.
  const [padDur, setPadDur] = useState(1.0);

  // ---- BPM detection (aubio) --------------------------------------
  // Cleared when the source file changes OR when the loop region's
  // presence changes (added or removed) — small region resizes keep
  // the previously-detected value but a fresh selection invalidates.
  const [bpm, setBpm] = useState<number | null>(null);
  const [bpmBusy, setBpmBusy] = useState(false);
  const [bpmError, setBpmError] = useState<string | null>(null);
  useEffect(() => {
    setBpm(null);
    setBpmError(null);
  }, [file?.path]);
  const hadRegionRef = useRef(false);
  useEffect(() => {
    const has = !!regionRange;
    if (has !== hadRegionRef.current) {
      setBpm(null);
      setBpmError(null);
      hadRegionRef.current = has;
    }
  }, [regionRange]);

  async function runDetectBpm() {
    if (!file || bpmBusy) return;
    setBpmBusy(true);
    setBpmError(null);
    try {
      const v = await detectBpm(
        file.path,
        regionRange ? { start: regionRange.start, end: regionRange.end } : undefined,
      );
      setBpm(v);
    } catch (e) {
      setBpmError(String(e));
    } finally {
      setBpmBusy(false);
    }
  }

  // Reset edit feedback when the user switches samples.
  useEffect(() => {
    setEditStatus(null);
  }, [file?.path]);

  // Resize the live waveform when density changes without re-decoding.
  useEffect(() => {
    wsRef.current?.setOptions({ height: D.waveHeight });
  }, [D.waveHeight]);

  // ---- volume (live, non-destructive) ------------------------------
  // We deliberately do NOT route through Web Audio here. On WebKit2GTK
  // wrapping the media element with createMediaElementSource hijacks
  // its audio path into the Web Audio graph, and the same destination
  // bug that mutes AudioBufferSourceNode (memory: feedback_webkit2gtk_audio)
  // applies — playback refuses or goes silent. Setting
  // HTMLMediaElement.volume directly via WaveSurfer.setVolume is
  // bypass-safe and gives us a master attenuator per track (0..1).
  // Default to 0.5 on every launch so a relaunch never blasts at
  // whatever level was last set — session-only, not persisted.
  const [volume, setVolume] = useState(0.5);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  useEffect(() => {
    wsRef.current?.setVolume(volume);
  }, [volume]);

  async function runGain() {
    if (!file || editBusy) return;
    setEditBusy("gain");
    setEditStatus(null);
    try {
      const linear = Math.pow(10, gainDb / 20);
      const path = await gainAudio(file.path, linear);
      setEditStatus({ kind: "ok", mode: "gain", path });
      onEdited?.(path);
    } catch (e) {
      setEditStatus({ kind: "err", mode: "gain", msg: String(e) });
    } finally {
      setEditBusy(null);
    }
  }

  async function runFade(direction: "fadein" | "fadeout") {
    if (!file || editBusy) return;
    setEditBusy(direction);
    setEditStatus(null);
    try {
      const fn = direction === "fadein" ? fadeInAudio : fadeOutAudio;
      const path = await fn(file.path, fadeDur);
      setEditStatus({ kind: "ok", mode: direction, path });
      onEdited?.(path);
    } catch (e) {
      setEditStatus({ kind: "err", mode: direction, msg: String(e) });
    } finally {
      setEditBusy(null);
    }
  }

  async function runFadeTail() {
    if (!file || editBusy) return;
    setEditBusy("fadetail");
    setEditStatus(null);
    try {
      const path = await fadeTailAudio(file.path, fadeDur, padDur);
      setEditStatus({ kind: "ok", mode: "fadetail", path });
      onEdited?.(path);
    } catch (e) {
      setEditStatus({ kind: "err", mode: "fadetail", msg: String(e) });
    } finally {
      setEditBusy(null);
    }
  }

  async function runPad(mode: "padstart" | "padend" | "padmid") {
    if (!file || editBusy) return;
    if (mode === "padmid" && !regionRange) return;
    setEditBusy(mode);
    setEditStatus(null);
    try {
      let path: string;
      if (mode === "padstart") path = await padStartAudio(file.path, padDur);
      else if (mode === "padend") path = await padEndAudio(file.path, padDur);
      else path = await padAtAudio(file.path, regionRange!.start, padDur);
      setEditStatus({ kind: "ok", mode, path });
      onEdited?.(path);
    } catch (e) {
      setEditStatus({ kind: "err", mode, msg: String(e) });
    } finally {
      setEditBusy(null);
    }
  }

  async function runEdit(mode: "trim" | "prune") {
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
    // Timeline ruler under the waveform — auto-spacing based on
    // duration; styled small + muted so it doesn't compete with the
    // wave for attention.
    const timeline = TimelinePlugin.create({
      height: 14,
      insertPosition: "afterend",
      style: {
        fontSize: "10px",
        color: WAVE,
      },
    });
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: WAVE,
      progressColor: PROGRESS,
      cursorColor: CURSOR,
      cursorWidth: 1,
      height: D.waveHeight,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      plugins: [regions, timeline],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    ws.on("ready", () => {
      if (cancelled) return;
      setDuration(ws.getDuration());
      setLoading(false);
      regions.enableDragSelection({ color: REGION_FILL });
      // Apply the current volume to the freshly-created element.
      // Read via ref so we use the latest value (the effect dep list
      // intentionally excludes `volume` — we don't want to rebuild ws
      // on slider drags).
      ws.setVolume(volumeRef.current);
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

  function cue() {
    stopRegionLoopWatch();
    const ws = wsRef.current;
    if (!ws) return;
    ws.pause();
    ws.setTime(0);
  }

  // Expose the transport to the App-level "master" strip. Closures
  // read wsRef.current at call time, so the handle stays correct
  // across file loads.
  useImperativeHandle(ref, () => ({ play, pause, stop, cue }), []);

  function toggleLoop() {
    setLoop((p) => !p);
  }

  function clearRegion() {
    regionsRef.current?.clearRegions();
  }

  const editReady = !!file && !!regionRange && regionRange.end > regionRange.start;
  const editDisabled = !editReady || editBusy !== null;

  // Slim: filename folds into the title so the panel can skip the
  // separate "now loaded" row. Wide: bare "Track N" title.
  const trackText = `Track${label ? ` ${label}` : ""}`;
  const titleContent =
    density === "slim" ? (
      <span className="flex items-baseline gap-2 min-w-0">
        <span className="shrink-0">{trackText}</span>
        {file ? (
          <span className="text-xs font-normal tracking-normal normal-case text-muted truncate">
            · {file.name}
          </span>
        ) : (
          <span className="text-xs font-normal tracking-normal normal-case text-muted/60">
            · no sample loaded
          </span>
        )}
      </span>
    ) : (
      <span>{trackText}</span>
    );
  // Title is a chevron-toggle button when the parent wires a handler.
  // Click bubbles through to the Section's onClick too, so the same
  // click also focuses this track — useful when collapsed.
  const title = onToggleExpand ? (
    <button
      type="button"
      onClick={onToggleExpand}
      aria-expanded={expanded}
      title={expanded ? "Collapse track" : "Expand track"}
      className="inline-flex items-center gap-1.5 min-w-0 hover:opacity-70 transition-opacity"
    >
      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      {titleContent}
    </button>
  ) : (
    titleContent
  );

  return (
    <Section
      title={title}
      icon={<Play size={16} />}
      onClick={onFocus}
      className={cn(
        D.section,
        onFocus && "cursor-pointer",
        focused && "ring-2 ring-accent/40",
      )}
    >
      {expanded && (
        <>
      {density === "wide" && (
        <div className="text-xs text-muted truncate">
          {file ? file.name : "No sample loaded"}
        </div>
      )}

      <div className="space-y-1">
        <div className="relative">
          <div ref={containerRef} className={D.waveContainer} />
          {duration > 0 && (
            <div
              aria-hidden="true"
              className={cn(
                "absolute inset-x-2 pointer-events-none",
                density === "slim" ? "top-1.5" : "top-2",
              )}
              style={{
                height: `${D.waveHeight}px`,
                backgroundImage: gridGradient(duration),
              }}
            />
          )}
        </div>
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

      {/* Transport row — always visible. Cue/Play/Stop grouped as a
          single outline chip so its shape matches the solid-fill
          MasterStrip between tracks; icon-only inside, tooltips carry
          the labels. */}
      <div className="flex items-center gap-2 flex-wrap">
        <div
          className={cn(
            "inline-flex rounded-md overflow-hidden border border-surface",
            (!file || loading) && "opacity-50",
          )}
        >
          <button
            onClick={cue}
            disabled={!file || loading}
            title="Cue — pause and return playhead to the start of the file"
            aria-label="Cue to start"
            className={cn(
              D.btn,
              "text-fg hover:bg-surface/60 transition-colors",
              "disabled:cursor-not-allowed",
              "flex items-center justify-center",
            )}
          >
            <SkipBack size={14} />
          </button>
          <button
            onClick={playing ? pause : play}
            disabled={!file || loading}
            title={playing ? "Pause" : "Play"}
            aria-label={playing ? "Pause" : "Play"}
            className={cn(
              D.btn,
              "border-l border-surface text-fg hover:bg-surface/60",
              "transition-colors disabled:cursor-not-allowed",
              "flex items-center justify-center",
            )}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            onClick={stop}
            disabled={!file || loading}
            title="Stop — pause and return to region start (or 0)"
            aria-label="Stop"
            className={cn(
              D.btn,
              "border-l border-surface text-fg hover:bg-surface/60",
              "transition-colors disabled:cursor-not-allowed",
              "flex items-center justify-center",
            )}
          >
            <Square size={14} />
          </button>
        </div>

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

        {/* BPM detection chip: click to detect on the current region
            (or whole file if no region). Re-click to redetect. Muted
            for samples (or selected regions) shorter than 5 s — too
            little material for a stable tempo estimate. */}
        {(() => {
          const effDur = regionRange
            ? regionRange.end - regionRange.start
            : duration;
          const tooShort = !!file && effDur > 0 && effDur < BPM_MIN_DURATION;
          return (
            <button
              onClick={runDetectBpm}
              disabled={
                !BPM_DETECTION_ENABLED || !file || bpmBusy || tooShort
              }
              title={
                !BPM_DETECTION_ENABLED
                  ? "BPM detection — experimental, currently disabled. The median-of-intervals math drifts on most real-world samples (octave-confused). Refinement queued in project memory."
                  : bpmBusy
                    ? "Detecting BPM…"
                    : tooShort
                      ? `${regionRange ? "Region" : "Sample"} shorter than ${BPM_MIN_DURATION}s — too little material for a stable BPM estimate`
                      : bpmError
                        ? `BPM detection failed: ${bpmError}`
                        : !file
                          ? "Load a sample first"
                          : bpm
                            ? `BPM (${regionRange ? "region" : "file"}): ${bpm.toFixed(2)} — click to redetect`
                            : `Detect BPM (${regionRange ? "region" : "whole file"})`
              }
              className={cn(
                "px-2 py-1 rounded-md bg-bg/50 hover:bg-surface/60",
                "text-[10px] font-mono inline-flex items-center gap-1.5",
                "disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
              )}
            >
              {bpmBusy ? (
                <Loader2 size={11} className="animate-spin text-muted" />
              ) : (
                <Gauge
                  size={11}
                  className={bpmError ? "text-alert" : "text-muted"}
                />
              )}
              <span className="text-muted">BPM</span>
              <span
                className={cn(
                  "tabular-nums",
                  bpm
                    ? "text-mauve"
                    : bpmError
                      ? "text-alert"
                      : "text-muted/60",
                )}
              >
                {bpmError ? "err" : bpm ? bpm.toFixed(1) : "—"}
              </span>
            </button>
          );
        })()}

        <div className="ml-auto flex items-center gap-2">
          <div
            className="inline-flex items-center gap-1.5"
            title={`Volume: ${Math.round(volume * 100)}%`}
          >
            <Volume2
              size={14}
              className={cn(file ? "text-muted" : "text-muted/40")}
            />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              disabled={!file || loading}
              aria-label="Track volume"
              className="w-20 accent-mauve disabled:opacity-50
                         disabled:cursor-not-allowed cursor-pointer"
            />
          </div>
          <button
            onClick={toggleLoop}
            disabled={!file || loading}
            className={cn(
              "rounded-md flex items-center gap-1.5",
              D.btn,
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
      </div>

      {/* Edits row — conditional. Toggle in the header chip. A small
          mt-2 separates it from the transport row above. */}
      {editsExpanded && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
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
            className={cn(
              D.btn,
              "rounded-md bg-surface hover:bg-surfaceHover",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "flex items-center gap-1.5 text-fg",
            )}
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
            className={cn(
              D.btn,
              "rounded-md bg-surface hover:bg-surfaceHover",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "flex items-center gap-1.5 text-fg",
            )}
          >
            {editBusy === "prune" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Scissors size={14} />
            )}
            Prune
          </button>

          {/* Gain: slider with dB readout + apply button, joined as a
              single compact chip. Range −24..+24 dB, step 0.5 dB. */}
          <div
            className={cn(
              "inline-flex items-stretch rounded-md overflow-hidden bg-surface",
              (!file || editBusy !== null) && "opacity-50",
            )}
            title={
              editBusy === "gain"
                ? "Applying gain…"
                : !file
                  ? "Load a sample first"
                  : `Apply ${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(1)} dB and save next to source`
            }
          >
            <div className={cn("inline-flex items-center gap-1.5", D.btn)}>
              <Volume2 size={12} className="text-muted shrink-0" />
              <input
                type="range"
                min={-24}
                max={24}
                step={0.5}
                value={gainDb}
                onChange={(e) => setGainDb(parseFloat(e.target.value))}
                disabled={!file || editBusy !== null}
                aria-label="Gain in dB"
                className="w-24 accent-mauve cursor-pointer disabled:cursor-not-allowed"
              />
              <span className="font-mono text-mauve tabular-nums w-10 text-right text-xs">
                {gainDb >= 0 ? "+" : ""}
                {gainDb.toFixed(1)}
              </span>
            </div>
            <button
              onClick={runGain}
              disabled={!file || editBusy !== null}
              className={cn(
                D.btn,
                "border-l border-bg/40 text-fg",
                "hover:bg-surfaceHover disabled:cursor-not-allowed",
                "flex items-center gap-1.5",
              )}
            >
              {editBusy === "gain" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : null}
              Gain
            </button>
          </div>

          {/* Fade: shared duration slider + separate fade-in / fade-out
              apply buttons. Each writes to *-fadein.{ext} / *-fadeout.{ext}. */}
          <div
            className={cn(
              "inline-flex items-stretch rounded-md overflow-hidden bg-surface",
              (!file || editBusy !== null) && "opacity-50",
            )}
            title={
              !file
                ? "Load a sample first"
                : `Fade duration: ${fadeDur.toFixed(2)}s`
            }
          >
            <div className={cn("inline-flex items-center gap-1.5", D.btn)}>
              <input
                type="range"
                min={0.05}
                max={10}
                step={0.05}
                value={fadeDur}
                onChange={(e) => setFadeDur(parseFloat(e.target.value))}
                disabled={!file || editBusy !== null}
                aria-label="Fade duration in seconds"
                className="w-24 accent-mauve cursor-pointer disabled:cursor-not-allowed"
              />
              <span className="font-mono text-mauve tabular-nums w-10 text-right text-xs">
                {fadeDur.toFixed(2)}s
              </span>
            </div>
            <button
              onClick={() => runFade("fadein")}
              disabled={!file || editBusy !== null}
              title={
                editBusy === "fadein"
                  ? "Fading in…"
                  : !file
                    ? "Load a sample first"
                    : `Fade in over ${fadeDur.toFixed(2)}s and save next to source`
              }
              className={cn(
                D.btn,
                "border-l border-bg/40 text-fg",
                "hover:bg-surfaceHover disabled:cursor-not-allowed",
                "flex items-center gap-1.5",
              )}
            >
              {editBusy === "fadein" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <TrendingUp size={14} />
              )}
              Fade in
            </button>
            <button
              onClick={() => runFade("fadeout")}
              disabled={!file || editBusy !== null}
              title={
                editBusy === "fadeout"
                  ? "Fading out…"
                  : !file
                    ? "Load a sample first"
                    : `Fade out over ${fadeDur.toFixed(2)}s and save next to source`
              }
              className={cn(
                D.btn,
                "border-l border-bg/40 text-fg",
                "hover:bg-surfaceHover disabled:cursor-not-allowed",
                "flex items-center gap-1.5",
              )}
            >
              {editBusy === "fadeout" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <TrendingDown size={14} />
              )}
              Fade out
            </button>
            <button
              onClick={runFadeTail}
              disabled={!file || editBusy !== null}
              title={
                editBusy === "fadetail"
                  ? "Fading + tailing…"
                  : !file
                    ? "Load a sample first"
                    : `Fade out over ${fadeDur.toFixed(2)}s, then append ${padDur.toFixed(2)}s of silence — uses the fade slider (here) for the fade and the pad slider for the tail`
              }
              className={cn(
                D.btn,
                "border-l border-bg/40 text-fg",
                "hover:bg-surfaceHover disabled:cursor-not-allowed",
                "flex items-center gap-1.5",
              )}
            >
              {editBusy === "fadetail" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <TrendingDown size={14} />
              )}
              Fade+tail
            </button>
          </div>

          {/* Pad: shared silence-duration slider + three apply buttons.
              Pad start / Pad end work on the whole file; Pad here
              inserts silence at region.start (disabled until a region
              is set). */}
          <div
            className={cn(
              "inline-flex items-stretch rounded-md overflow-hidden bg-surface",
              (!file || editBusy !== null) && "opacity-50",
            )}
            title={
              !file
                ? "Load a sample first"
                : `Silence duration: ${padDur.toFixed(2)}s`
            }
          >
            <div className={cn("inline-flex items-center gap-1.5", D.btn)}>
              <input
                type="range"
                min={0.05}
                max={10}
                step={0.05}
                value={padDur}
                onChange={(e) => setPadDur(parseFloat(e.target.value))}
                disabled={!file || editBusy !== null}
                aria-label="Pad silence duration in seconds"
                className="w-24 accent-mauve cursor-pointer disabled:cursor-not-allowed"
              />
              <span className="font-mono text-mauve tabular-nums w-10 text-right text-xs">
                {padDur.toFixed(2)}s
              </span>
            </div>
            <button
              onClick={() => runPad("padstart")}
              disabled={!file || editBusy !== null}
              title={
                editBusy === "padstart"
                  ? "Padding start…"
                  : !file
                    ? "Load a sample first"
                    : `Prepend ${padDur.toFixed(2)}s of silence and save next to source`
              }
              className={cn(
                D.btn,
                "border-l border-bg/40 text-fg",
                "hover:bg-surfaceHover disabled:cursor-not-allowed",
                "flex items-center gap-1.5",
              )}
            >
              {editBusy === "padstart" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ArrowLeftToLine size={14} />
              )}
              Pad start
            </button>
            <button
              onClick={() => runPad("padend")}
              disabled={!file || editBusy !== null}
              title={
                editBusy === "padend"
                  ? "Padding end…"
                  : !file
                    ? "Load a sample first"
                    : `Append ${padDur.toFixed(2)}s of silence and save next to source`
              }
              className={cn(
                D.btn,
                "border-l border-bg/40 text-fg",
                "hover:bg-surfaceHover disabled:cursor-not-allowed",
                "flex items-center gap-1.5",
              )}
            >
              {editBusy === "padend" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ArrowRightToLine size={14} />
              )}
              Pad end
            </button>
            <button
              onClick={() => runPad("padmid")}
              disabled={!file || editBusy !== null || !regionRange}
              title={
                editBusy === "padmid"
                  ? "Padding at region…"
                  : !file
                    ? "Load a sample first"
                    : !regionRange
                      ? "Drag a loop region first — silence is inserted at its start"
                      : `Insert ${padDur.toFixed(2)}s of silence at ${fmtSecs(regionRange.start)} and save next to source`
              }
              className={cn(
                D.btn,
                "border-l border-bg/40 text-fg",
                "hover:bg-surfaceHover disabled:cursor-not-allowed",
                "flex items-center gap-1.5",
              )}
            >
              {editBusy === "padmid" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Split size={14} />
              )}
              Pad here
            </button>
          </div>
        </div>
      )}

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
        </>
      )}
    </Section>
  );
});
