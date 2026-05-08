import { useEffect, useRef, useState } from "react";
import { Pause, Play, Repeat, Square, X } from "lucide-react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, {
  type Region,
} from "wavesurfer.js/dist/plugins/regions.esm.js";
import { Section } from "./Section";
import { readAudioFile, type AudioFile, type AudioInfo } from "../lib/tauri";
import { cn } from "../lib/cn";

interface PlayerProps {
  file: AudioFile | null;
  onAudioInfo?: (info: AudioInfo | null) => void;
}

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

export function Player({ file, onAudioInfo }: PlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // WaveSurfer instance + decoded buffer (used for both waveform and Web
  // Audio loop playback).
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const activeRegionRef = useRef<Region | null>(null);
  const decodedBufferRef = useRef<AudioBuffer | null>(null);

  // Sample-accurate region loop: bypass HTMLMediaElement and use a
  // dedicated AudioBufferSourceNode with loop=true + loopStart/loopEnd.
  // The audio engine handles the loop boundary atomically — zero gap.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const loopAnchorRef = useRef(0); // ctx.currentTime when source.start fired
  const cursorRafRef = useRef(0);

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

  // ---- Web Audio loop helpers ---------------------------------------
  function ensureAudioContext(): AudioContext {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext({ latencyHint: "interactive" });
    }
    return audioCtxRef.current;
  }

  async function ensureRunning(): Promise<AudioContext> {
    const ctx = ensureAudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    return ctx;
  }

  function stopWebAudioLoop() {
    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
      } catch {
        /* already stopped */
      }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (cursorRafRef.current) {
      cancelAnimationFrame(cursorRafRef.current);
      cursorRafRef.current = 0;
    }
  }

  async function startWebAudioLoop(start: number, end: number): Promise<boolean> {
    const buffer = decodedBufferRef.current;
    if (!buffer) return false;

    stopWebAudioLoop();
    wsRef.current?.pause();

    const ctx = await ensureRunning();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = start;
    source.loopEnd = end;
    source.connect(ctx.destination);
    source.start(0, start);
    source.onended = () => {
      // Fires when source.stop() is called (or buffer ends naturally,
      // which should never happen with loop=true).
      if (sourceRef.current === source) {
        sourceRef.current = null;
        setPlaying(false);
      }
    };

    sourceRef.current = source;
    loopAnchorRef.current = ctx.currentTime;
    setPlaying(true);

    // Sync WaveSurfer cursor to the Web Audio playhead at rAF rate.
    const tick = () => {
      const r = activeRegionRef.current;
      const ws = wsRef.current;
      if (!sourceRef.current || !audioCtxRef.current || !r || !ws) return;
      const elapsed = audioCtxRef.current.currentTime - loopAnchorRef.current;
      const len = source.loopEnd - source.loopStart;
      const pos = len > 0 ? source.loopStart + (elapsed % len) : source.loopStart;
      ws.setTime(pos);
      setTime(pos);
      cursorRafRef.current = requestAnimationFrame(tick);
    };
    cursorRafRef.current = requestAnimationFrame(tick);

    return true;
  }

  // Stop Web Audio loop if user toggles loop off mid-playback.
  useEffect(() => {
    if (!loop && sourceRef.current) {
      stopWebAudioLoop();
    }
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
    decodedBufferRef.current = null;
    stopWebAudioLoop();
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
      // If our own pre-decode hasn't landed yet (race), fall back to
      // WaveSurfer's buffer. Otherwise our ctx-bound buffer wins.
      if (!decodedBufferRef.current) {
        decodedBufferRef.current = ws.getDecodedData();
      }
      setLoading(false);
      regions.enableDragSelection({ color: REGION_FILL });
    });
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => {
      // Don't flip the playing flag if we're driving via Web Audio
      // (we paused the WaveSurfer media intentionally to mute it).
      if (!sourceRef.current) setPlaying(false);
    });
    ws.on("timeupdate", (t: number) => {
      // Only let WaveSurfer push time updates when Web Audio isn't driving.
      if (!sourceRef.current) setTime(t);
    });
    ws.on("finish", () => {
      // Whole-file loop when no region is selected.
      if (loopRef.current && !activeRegionRef.current) {
        ws.setTime(0);
        void ws.play();
      }
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
      // Live-update the running Web Audio source if we're in loop mode.
      if (sourceRef.current) {
        sourceRef.current.loopStart = r.start;
        sourceRef.current.loopEnd = r.end;
      }
    });
    regions.on("region-removed", (r: Region) => {
      if (activeRegionRef.current?.id === r.id) {
        activeRegionRef.current = null;
        setRegionRange(null);
        // If we were looping that region, drop back to silence.
        stopWebAudioLoop();
      }
    });

    readAudioFile(file.path)
      .then((buffer) => {
        if (cancelled) return;

        // Pre-decode into our own AudioContext so the buffer is bound
        // to the context we'll play it from (matched sample rate, no
        // resample latency) AND the context warms up before the user
        // ever clicks Play (eliminates first-iteration startup delay).
        // decodeAudioData transfers ownership of the ArrayBuffer, so we
        // hand it a copy and keep the original for the Blob.
        const ctx = ensureAudioContext();
        void ctx.decodeAudioData(buffer.slice(0))
          .then((b) => {
            if (cancelled) return;
            decodedBufferRef.current = b;
            onAudioInfo?.({
              sampleRate: b.sampleRate,
              channels: b.numberOfChannels,
              duration: b.duration,
            });
          })
          .catch(() => {
            // Decode in our context failed (rare — bad codec); fall
            // back to WaveSurfer's buffer when 'ready' fires.
          });
        // Eagerly resume so the engine is hot by play time.
        if (ctx.state === "suspended") void ctx.resume();

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
      stopWebAudioLoop();
      ws.destroy();
      if (wsRef.current === ws) wsRef.current = null;
      if (regionsRef.current === regions) regionsRef.current = null;
    };
  }, [file?.path, file?.name]);

  // Tear down the AudioContext on unmount (separate effect so it
  // survives file changes).
  useEffect(() => {
    return () => {
      stopWebAudioLoop();
      if (audioCtxRef.current) {
        void audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
    };
  }, []);

  // ---- transport ---------------------------------------------------
  async function play() {
    const ws = wsRef.current;
    const r = activeRegionRef.current;
    if (!ws) return;

    // Sample-accurate region loop via Web Audio.
    if (loop && r && decodedBufferRef.current) {
      if (await startWebAudioLoop(r.start, r.end)) return;
    }

    // Fallback: WaveSurfer / HTMLMediaElement transport.
    if (r && (ws.getCurrentTime() < r.start || ws.getCurrentTime() >= r.end)) {
      ws.setTime(r.start);
    }
    void ws.play().catch((e: unknown) => setError(String(e)));
  }

  function pause() {
    if (sourceRef.current) {
      stopWebAudioLoop();
    } else {
      wsRef.current?.pause();
    }
  }

  function stop() {
    stopWebAudioLoop();
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

  return (
    <Section title="Player" icon={<Play size={16} />}>
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
              ? "Loop the selected region (sample-accurate via Web Audio)"
              : "Loop the whole file"
          }
        >
          <Repeat size={14} /> Loop
        </button>
      </div>
    </Section>
  );
}
