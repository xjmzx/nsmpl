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
  Crop,
  Equal,
  FileDown,
  Gauge,
  Loader2,
  Pause,
  Play,
  Repeat,
  Scissors,
  SkipBack,
  Split,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, {
  type Region,
} from "wavesurfer.js/dist/plugins/regions.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import { Section } from "./Section";
import { BounceStatus, type BounceView } from "./BounceStatus";
import { EnvelopeStrip } from "./EnvelopeStrip";
import {
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
  density?: "super-slim" | "slim" | "wide";
  // Show the destructive-edits row (Trim/Prune/Gain/Fade). Default
  // collapsed — the deck-first UX keeps transport prominent and edits
  // out of the way.
  editsExpanded?: boolean;
  // Whole-track collapse. When false, only the title row renders so
  // the deck pair can shrink down to two compact lines + master strip.
  expanded?: boolean;
  onToggleExpand?: () => void;
  // Counterpart track's file duration (seconds) and label — used by
  // the "Match" edit button to length-match this track to the other.
  // null when there's no other visible track or it has no file loaded.
  otherDuration?: number | null;
  otherLabel?: string;
  // Single-track Bounce. When provided, a Bounce button renders in
  // the transport row that fires `onBounce` (App owns the IPC call).
  // Omitted in 2-track mode — the MasterStrip's Bounce handles the
  // mixed bounce instead. `bounceView` drives the inline status line
  // (idle / running / done / failed) shown under the transport row.
  onBounce?: () => void;
  bounceView?: BounceView;
  /// Global mute applied from the master strip. When true, this
  /// track is silent regardless of its own per-track mute toggle.
  /// Independent state — App owns `masterMuted`, each Player owns
  /// its own `muted`, the audio element uses the OR of both.
  masterMuted?: boolean;
}

// Density-dependent classNames + waveform pixel height. Slim is the
// installed default; wide reverts to the pre-slim layout.
// Vertical diet (2026): every tier slimmed one notch — wide now ≈ the old
// slim, slim ≈ the old super-slim, and super-slim is pared thinner still. The
// division grid (gridGradient) is height-independent, so it stays the
// consistent structural reference across all three even at the thinnest wave.
const DENSITY = {
  "super-slim": {
    waveHeight: 18,
    waveContainer: "rounded-md bg-bg/50 px-2 py-0.5 min-h-[38px]",
    section: "p-1.5 gap-1",
    btn: "px-2 py-0.5 text-[11px]",
  },
  slim: {
    waveHeight: 28,
    waveContainer: "rounded-md bg-bg/50 px-2 py-1 min-h-[52px]",
    section: "p-2 gap-1.5",
    btn: "px-2 py-1 text-[11px]",
  },
  wide: {
    waveHeight: 56,
    waveContainer: "rounded-md bg-bg/50 px-2 py-1.5 min-h-[90px]",
    section: "p-3 gap-2",
    btn: "px-2.5 py-1.5 text-xs",
  },
} as const;

type EditMode =
  | "trim"
  | "prune"
  | "gain"
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
  /// Playhead position within the active loop region (0 if at the
  /// loop start, region.end - region.start at the loop end), or
  /// just currentTime if no region is set. Master uses this so its
  /// readout naturally resets when the loop wraps.
  getLoopPosition: () => number;
  /// Current loop region in seconds, or null if no region is set.
  /// Used by the master Bounce to render only the looped portion.
  getLoopRange: () => { start: number; end: number } | null;
  /// Current non-destructive fade lengths (seconds). 0 = no fade.
  /// Read by the master Bounce so each track's envelope bakes into
  /// the rendered WAV.
  getFades: () => { fadeInSec: number; fadeOutSec: number };
  /// True when the user has asked this track to length-match the
  /// other at bounce time. App reads this + the other track's
  /// audible length to compute the apad/atrim target.
  getMatchOther: () => boolean;
  /// Hard reset: destroys + recreates the WaveSurfer instance from
  /// the currently loaded file. Recovers from any locked audio-engine
  /// state. Preserves the user's file selection, fade values, match
  /// toggle and volume; the loop region is cleared since it lives
  /// inside the wavesurfer instance.
  reset: () => void;
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
      { interval: 1, opacity: 0.9 },
      { interval: 0.5, opacity: 0.55 },
      { interval: 0.1, opacity: 0.28 },
    ];
  }
  if (duration < 30) {
    return [
      { interval: 5, opacity: 0.9 },
      { interval: 1, opacity: 0.55 },
      { interval: 0.5, opacity: 0.28 },
    ];
  }
  if (duration < 120) {
    return [
      { interval: 10, opacity: 0.9 },
      { interval: 5, opacity: 0.55 },
      { interval: 1, opacity: 0.28 },
    ];
  }
  return [
    { interval: 60, opacity: 0.9 },
    { interval: 10, opacity: 0.55 },
    { interval: 5, opacity: 0.28 },
  ];
}
function gridGradient(duration: number): string {
  const tiers = gridTiersFor(duration);
  if (tiers.length === 0) return "none";
  // Brighter cursor-tone (rgb 205,214,244) instead of slate, plus a
  // hard pixel stop for crisper lines against the wave bars.
  // First listed = topmost in CSS painting order; major tier sits
  // on top so it doesn't get washed out by the finer layers.
  return tiers
    .map((t) => {
      const segments = Math.max(1, Math.round(duration / t.interval));
      const pct = 100 / segments;
      return (
        `repeating-linear-gradient(to right, ` +
        `rgba(205, 214, 244, ${t.opacity}) 0, ` +
        `rgba(205, 214, 244, ${t.opacity}) 1px, ` +
        `transparent 1px, transparent ${pct}%)`
      );
    })
    .join(", ");
}

// Manual-bars BPM workaround while aubio-based auto detection
// remains parked (see memory: project_smpl_audio_backlog). User
// cycles through common bar-count assumptions and we compute
// BPM = (bars × 4 ÷ loopLen) × 60, rounded.
// Half-bar entry lets users snap to 8th-note-style loops (drum
// fills, half-bar phrases). 4 beats per bar is the 4/4 assumption
// the BPM math is locked to.
const BAR_OPTIONS = [0.5, 1, 2, 4, 8, 16] as const;
type BarOption = (typeof BAR_OPTIONS)[number];
// Floor below which the calc is nonsense (one drum hit, not a loop).
const BPM_MIN_DURATION = 0.1; // seconds

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
    otherDuration = null,
    otherLabel,
    onBounce,
    bounceView,
    masterMuted = false,
  },
  ref,
) {
  const bounceBusy = bounceView?.status === "running";
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
  // Shared pad duration (seconds) for start/end/at-region inserts.
  const [padDur, setPadDur] = useState(1.0);
  // ---- non-destructive envelope (bake-at-bounce) ------------------
  // Per-Track fade lengths the user drags out on the EnvelopeStrip.
  // Live audio preview multiplies HTMLMediaElement.volume by the
  // computed envelope multiplier; the values get baked into the
  // ffmpeg filter chain at bounce time. Reset to 0 on file change
  // — each new sample starts dry.
  const [fadeInSec, setFadeInSec] = useState(0);
  const [fadeOutSec, setFadeOutSec] = useState(0);
  // Non-destructive "match the other track's length" flag. When true,
  // the bounce pads (apad) or trims (atrim) this track to the other
  // track's audible length at render time. Reset on file change.
  const [matchOther, setMatchOther] = useState(false);
  // Bump this to force the WaveSurfer mount effect to re-run with
  // the current file — used by Master Reset to recover from a
  // wedged audio engine without losing the user's file/fade/match
  // selections.
  const [resetTick, setResetTick] = useState(0);
  // Ref pipes so the imperative handle's getters read the latest
  // values without re-binding the handle.
  const fadeInRef = useRef(fadeInSec);
  const fadeOutRef = useRef(fadeOutSec);
  const matchOtherRef = useRef(matchOther);
  fadeInRef.current = fadeInSec;
  fadeOutRef.current = fadeOutSec;
  matchOtherRef.current = matchOther;

  // ---- BPM (manual bars-based calc) -------------------------------
  // User cycles through bar-count assumptions; we derive BPM from
  // the current loop length. Survives file changes (user usually
  // keeps the same expectation across loads).
  const [loopBars, setLoopBars] = useState<number>(1);
  function cycleLoopBars() {
    const i = BAR_OPTIONS.indexOf(loopBars as BarOption);
    setLoopBars(BAR_OPTIONS[(i + 1) % BAR_OPTIONS.length]);
  }

  // Snap loop region to the next bar count in BAR_OPTIONS, preserving
  // the current BPM. bar_dur = region_len / loopBars at click time, so
  // after the resize the new loopBars × new bar_dur = new region_len
  // gives the same BPM. Clamps end at file duration if the requested
  // bar count would overflow the source.
  function cycleAndSnapBars() {
    const region = activeRegionRef.current;
    if (!region || !regionRange) return;
    const regionLen = regionRange.end - regionRange.start;
    if (regionLen <= 0 || loopBars <= 0) return;
    const barDur = regionLen / loopBars;
    const i = BAR_OPTIONS.indexOf(loopBars as BarOption);
    const next = BAR_OPTIONS[(i + 1) % BAR_OPTIONS.length];
    const desiredEnd = regionRange.start + next * barDur;
    const clampedEnd = Math.min(desiredEnd, duration);
    region.setOptions({
      start: regionRange.start,
      end: clampedEnd,
    });
    setLoopBars(next);
  }

  function fmtBars(b: number): string {
    return b === 0.5 ? "½" : `${b}`;
  }

  // Reset edit feedback when the user switches samples.
  useEffect(() => {
    setEditStatus(null);
  }, [file?.path]);

  // Reset envelope fades on file change — per-spec, each new sample
  // is a clean slate. (Region change keeps the fade values; the
  // envelope just re-targets to the new region length.)
  useEffect(() => {
    setFadeInSec(0);
    setFadeOutSec(0);
    setMatchOther(false);
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

  // ---- mute (per-track + master) ---------------------------------
  // Per-track toggle. Independent of volume so the user's slider
  // value is preserved across mute/unmute. Effective mute is
  // `muted || masterMuted` — either can silence the track.
  const [muted, setMuted] = useState(false);
  const effectiveMuted = muted || masterMuted;
  const effectiveMutedRef = useRef(effectiveMuted);
  effectiveMutedRef.current = effectiveMuted;
  useEffect(() => {
    wsRef.current?.setMuted(effectiveMuted);
  }, [effectiveMuted]);

  // ---- envelope rAF -----------------------------------------------
  // While playing AND a fade is set, ride the volume continuously so
  // the user hears the same fade shape they'll get from the bounce.
  // Uses HTMLMediaElement.volume (via WaveSurfer.setVolume) — no Web
  // Audio nodes, so the WebKit2GTK mute issue doesn't apply.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    if (!playing || (fadeInSec === 0 && fadeOutSec === 0)) {
      // Either not playing or no envelope to ride — make sure volume
      // is at the dry user-set value.
      ws.setVolume(volume);
      return;
    }
    let raf = 0;
    function tick() {
      const ws = wsRef.current;
      if (!ws) return;
      const region = activeRegionRef.current;
      const regionStart = region?.start ?? 0;
      const regionEnd = region?.end ?? duration;
      const len = regionEnd - regionStart;
      const tInRegion = Math.max(0, ws.getCurrentTime() - regionStart);
      let m = 1;
      if (fadeInSec > 0 && tInRegion < fadeInSec) {
        m *= tInRegion / fadeInSec;
      }
      if (fadeOutSec > 0 && tInRegion > len - fadeOutSec) {
        m *= Math.max(0, (len - tInRegion) / fadeOutSec);
      }
      ws.setVolume(volume * Math.max(0, Math.min(1, m)));
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Restore the dry volume on cleanup so the slider value is
      // honoured next time the rAF isn't running.
      wsRef.current?.setVolume(volume);
    };
  }, [playing, fadeInSec, fadeOutSec, volume, duration]);

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
      // Apply the current volume + mute to the freshly-created
      // element. Read via refs so we use the latest values (the
      // effect dep list intentionally excludes `volume` and `muted`
      // — we don't want to rebuild ws on slider/toggle changes).
      ws.setVolume(volumeRef.current);
      ws.setMuted(effectiveMutedRef.current);
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
  }, [file?.path, file?.name, resetTick]);

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
  useImperativeHandle(
    ref,
    () => ({
      play,
      pause,
      stop,
      cue,
      getLoopPosition: () => {
        const ws = wsRef.current;
        if (!ws) return 0;
        const t = ws.getCurrentTime();
        const start = activeRegionRef.current?.start ?? 0;
        return Math.max(0, t - start);
      },
      getLoopRange: () => {
        const r = activeRegionRef.current;
        if (!r) return null;
        return { start: r.start, end: r.end };
      },
      getFades: () => ({
        fadeInSec: fadeInRef.current,
        fadeOutSec: fadeOutRef.current,
      }),
      getMatchOther: () => matchOtherRef.current,
      reset: () => setResetTick((n) => n + 1),
    }),
    [],
  );

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
  const title =
    density !== "wide" ? (
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

  return (
    <Section
      title={title}
      icon={<Play size={16} />}
      onClick={onFocus}
      onTitleClick={onToggleExpand}
      className={cn(
        D.section,
        "border-mauve/30",
        onFocus && "cursor-pointer",
        focused && "ring-2 ring-accent/40",
        // Uniform collapsed height across every panel.
        !expanded && "min-h-[5rem]",
      )}
    >
      {/* Body is always rendered, only hidden via CSS when collapsed.
          Unmounting on collapse used to detach the WaveSurfer container
          and leave the engine pointed at a dead DOM node — the visible
          symptom was play/pause silently no-op'ing after a
          collapse+expand cycle. Keeping the DOM stable preserves
          WaveSurfer's bindings, event listeners, rAF envelope loop and
          all the rest of the per-track state. */}
      <div
        className={cn(
          "flex flex-col gap-3",
          !expanded && "hidden",
        )}
      >
      {density === "wide" && (
        <div className="text-xs text-muted truncate">
          {file ? file.name : "No sample loaded"}
        </div>
      )}

      <div className="space-y-1">
        {/* Envelope strip — sits above the waveform, drag handles set
            non-destructive fade-in / fade-out. duration target follows
            the loop region when one is set (so previewed fade length
            matches what the bounce will produce). */}
        <EnvelopeStrip
          duration={
            regionRange ? regionRange.end - regionRange.start : duration
          }
          fadeInSec={fadeInSec}
          fadeOutSec={fadeOutSec}
          onFadeInChange={setFadeInSec}
          onFadeOutChange={setFadeOutSec}
          disabled={!file || loading}
        />
        <div className="relative">
          <div ref={containerRef} className={D.waveContainer} />
          {duration > 0 && (
            <div
              aria-hidden="true"
              className={cn(
                "absolute inset-x-2 pointer-events-none",
                density === "wide"
                  ? "top-1.5"
                  : density === "super-slim"
                    ? "top-0.5"
                    : "top-1",
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
          // Entire chip is clickable to clear — bigger hit area
          // than the tiny X alone. Hover tints the readout alert so
          // the destructive intent is visible before clicking.
          <button
            type="button"
            onClick={clearRegion}
            title="Click anywhere on this chip to clear the loop region"
            aria-label="Clear loop region"
            className="group ml-2 px-2 py-1 rounded-md bg-bg/50 hover:bg-alert/10
                       text-[10px] font-mono text-fg/80 flex items-center gap-1.5
                       transition-colors cursor-pointer"
          >
            <span className="text-muted group-hover:text-alert/80">region</span>
            <span>{fmtSecs(regionRange.start)}</span>
            <span className="text-muted group-hover:text-alert/80">→</span>
            <span>{fmtSecs(regionRange.end)}</span>
            <span className="text-muted group-hover:text-alert/80">
              ({fmtSecs(regionRange.end - regionRange.start)})
            </span>
            <X
              size={13}
              className="ml-1 text-muted group-hover:text-alert"
            />
          </button>
        )}

        {/* BPM + snap. The BPM chip cycles the bar-count *assumption*
            for the current region (interpretive — region length stays
            put, BPM number changes). The snap chip cycles the bar
            count AND resizes the region to match the new bar count at
            the current BPM (active — region length changes, BPM
            stays). Once the user has dialled in the right BPM via the
            BPM chip, the snap chip becomes the "loop every ½ / 1 / 2
            / 4 / 8 / 16 bars" control. */}
        {(() => {
          const loopLen = regionRange
            ? regionRange.end - regionRange.start
            : duration;
          const enoughMaterial =
            !!file && loopLen > BPM_MIN_DURATION;
          const calcBpm = enoughMaterial
            ? Math.round(((loopBars * 4) / loopLen) * 60)
            : null;
          return (
            <>
            <button
              onClick={cycleLoopBars}
              disabled={!file}
              title={
                !file
                  ? "Load a sample first"
                  : !enoughMaterial
                    ? "Loop too short to estimate BPM"
                    : `Assumes ${fmtBars(loopBars)} bar${loopBars === 1 ? "" : "s"} of 4 beats in ${loopLen.toFixed(3)}s → ${calcBpm} BPM. Click to cycle bar-count assumption (interpretive — region length unchanged).`
              }
              className={cn(
                "px-2 py-1 rounded-md bg-bg/50 hover:bg-surface/60",
                "text-[10px] font-mono inline-flex items-center gap-1.5",
                "disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
              )}
            >
              <Gauge size={11} className="text-muted" />
              <span className="text-muted">BPM</span>
              <span
                className={cn(
                  "tabular-nums",
                  calcBpm ? "text-mauve" : "text-muted/60",
                )}
              >
                {calcBpm ?? "—"}
              </span>
              <span className="text-muted/70 text-[9px] ml-0.5">
                {fmtBars(loopBars)}b
              </span>
            </button>

            {/* Snap chip — cycles loopBars AND resizes the loop region
                to match (preserving BPM). Requires a region: bar
                duration is derived from current region_len / loopBars. */}
            <button
              onClick={cycleAndSnapBars}
              disabled={!file || !regionRange || !enoughMaterial}
              title={
                !file
                  ? "Load a sample first"
                  : !regionRange
                    ? "Drag a loop region first — snap resizes it to a bar count"
                    : !enoughMaterial
                      ? "Loop too short for bar-count snap"
                      : (() => {
                          const i = BAR_OPTIONS.indexOf(loopBars as BarOption);
                          const next =
                            BAR_OPTIONS[(i + 1) % BAR_OPTIONS.length];
                          const barDur = loopLen / loopBars;
                          const newLen = next * barDur;
                          return `Snap loop region to ${fmtBars(next)} bar${next === 1 ? "" : "s"} (${newLen.toFixed(3)}s) at ${calcBpm} BPM. Click cycles to the next bar count.`;
                        })()
              }
              className={cn(
                "px-2 py-1 rounded-md bg-bg/50 hover:bg-accent/15",
                "text-[10px] font-mono inline-flex items-center gap-1.5",
                "text-accent disabled:opacity-50 disabled:cursor-not-allowed",
                "transition-colors",
              )}
            >
              <Repeat size={11} />
              <span>snap</span>
              <span className="tabular-nums">{fmtBars(loopBars)}b</span>
            </button>
            </>
          );
        })()}

        {/* Match → other-track length. Non-destructive toggle — when
            on, the bounce pads/trims this track to the other track's
            file duration. Only rendered in 2-track mode (otherDuration
            != null guarantees a second track is loaded). Mirrors the
            envelope-strip philosophy: live preview is just the toggle
            state, the actual length change happens at bounce. */}
        {otherDuration != null && (
          <button
            type="button"
            onClick={() => setMatchOther((p) => !p)}
            disabled={!file}
            title={
              !file
                ? "Load a sample first"
                : matchOther
                  ? `Match → T${otherLabel}: ${otherDuration.toFixed(3)}s — bounce will pad/trim this track to that length. Click to disable.`
                  : `Match this track's length to Track ${otherLabel} (${otherDuration.toFixed(3)}s) at bounce time — non-destructive`
            }
            aria-pressed={matchOther}
            className={cn(
              "px-2 py-1 rounded-md text-[10px] font-mono inline-flex items-center gap-1.5",
              "disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
              matchOther
                ? "bg-accent/20 text-accent hover:bg-accent/30"
                : "bg-bg/50 text-muted hover:bg-surface/60",
            )}
          >
            <Equal size={11} />
            <span>match</span>
            <span className="text-fg/80">T{otherLabel ?? "?"}</span>
            {matchOther && (
              <span className="tabular-nums">
                {otherDuration.toFixed(2)}s
              </span>
            )}
          </button>
        )}

        {/* Single-track Bounce — renders this track's loop region (or
            full file when no region) to a fresh WAV next to source.
            Only present when App provides `onBounce` (1-track mode);
            the MasterStrip's Bounce takes over in 2-track mode. */}
        {onBounce && (
          <button
            type="button"
            onClick={onBounce}
            disabled={!file || loading || bounceBusy}
            title={
              regionRange
                ? "Bounce — render this track's loop region to a fresh WAV"
                : "Bounce — render this track to a fresh WAV"
            }
            aria-label="Bounce track to WAV"
            className={cn(
              "px-2 py-1 rounded-md bg-bg/50 hover:bg-auburn/15",
              "text-[10px] font-mono inline-flex items-center gap-1.5",
              "text-auburn disabled:opacity-50 disabled:cursor-not-allowed",
              "transition-colors",
            )}
          >
            {bounceBusy ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <FileDown size={11} />
            )}
            <span>bounce</span>
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Volume icon doubles as a mute toggle — click to silence
              this track without disturbing the slider value. When the
              master strip's mute is on, this icon also reflects the
              silenced state (effectiveMuted) but only the per-track
              `muted` state flips on click. */}
          <div
            className="inline-flex items-center gap-1.5"
            title={
              !file
                ? "Load a sample first"
                : masterMuted
                  ? "Master is muted — toggle master mute to hear the track"
                  : muted
                    ? "Muted — click to unmute"
                    : `Volume: ${Math.round(volume * 100)}% — click the icon to mute`
            }
          >
            <button
              type="button"
              onClick={() => setMuted((p) => !p)}
              disabled={!file || loading}
              aria-label={muted ? "Unmute track" : "Mute track"}
              aria-pressed={muted}
              className={cn(
                "rounded p-0.5 transition-colors",
                "disabled:opacity-40 disabled:cursor-not-allowed",
                effectiveMuted
                  ? "text-alert hover:bg-alert/15"
                  : file
                    ? "text-muted hover:text-fg hover:bg-surface/60"
                    : "text-muted/40",
              )}
            >
              {effectiveMuted ? (
                <VolumeX size={14} />
              ) : (
                <Volume2 size={14} />
              )}
            </button>
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

      {/* Bounce status — visible only in single-track mode when a
          bounce has run or is running. idle render returns null
          inside BounceStatus, so this whole row collapses to nothing
          when there's no signal to show. */}
      {bounceView && bounceView.status !== "idle" && (
        <div className="-mt-1">
          <BounceStatus view={bounceView} />
        </div>
      )}

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

          {/* Pad: icon-only group with a shared "pad" label + duration
              slider on the left. Three destructive operations writing
              new files: pad start (apad before), pad end (apad after),
              pad here (silence inserted at region.start). Kept icon-
              only because in the envelope era these are corner-case
              tools — non-destructive bake-at-bounce is the everyday
              path. */}
          <div
            className={cn(
              "inline-flex items-stretch rounded-md overflow-hidden bg-surface",
              (!file || editBusy !== null) && "opacity-50",
            )}
            title={
              !file
                ? "Load a sample first"
                : `Pad — silence duration: ${padDur.toFixed(2)}s`
            }
          >
            <div className={cn("inline-flex items-center gap-1.5", D.btn)}>
              <span className="text-[10px] uppercase tracking-wide text-muted">
                pad
              </span>
              <input
                type="range"
                min={0.05}
                max={10}
                step={0.05}
                value={padDur}
                onChange={(e) => setPadDur(parseFloat(e.target.value))}
                disabled={!file || editBusy !== null}
                aria-label="Pad silence duration in seconds"
                className="w-20 accent-mauve cursor-pointer disabled:cursor-not-allowed"
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
                    : `Pad start — prepend ${padDur.toFixed(2)}s of silence (writes new file)`
              }
              aria-label="Pad start"
              className={cn(
                D.btn,
                "border-l border-bg/40 text-fg",
                "hover:bg-surfaceHover disabled:cursor-not-allowed",
                "flex items-center justify-center",
              )}
            >
              {editBusy === "padstart" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ArrowLeftToLine size={14} />
              )}
            </button>
            <button
              onClick={() => runPad("padend")}
              disabled={!file || editBusy !== null}
              title={
                editBusy === "padend"
                  ? "Padding end…"
                  : !file
                    ? "Load a sample first"
                    : `Pad end — append ${padDur.toFixed(2)}s of silence (writes new file)`
              }
              aria-label="Pad end"
              className={cn(
                D.btn,
                "border-l border-bg/40 text-fg",
                "hover:bg-surfaceHover disabled:cursor-not-allowed",
                "flex items-center justify-center",
              )}
            >
              {editBusy === "padend" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ArrowRightToLine size={14} />
              )}
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
                      : `Pad here — insert ${padDur.toFixed(2)}s of silence at ${fmtSecs(regionRange.start)} (writes new file)`
              }
              aria-label="Pad at region start"
              className={cn(
                D.btn,
                "border-l border-bg/40 text-fg",
                "hover:bg-surfaceHover disabled:cursor-not-allowed",
                "flex items-center justify-center",
              )}
            >
              {editBusy === "padmid" ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Split size={14} />
              )}
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
      </div>
    </Section>
  );
});
