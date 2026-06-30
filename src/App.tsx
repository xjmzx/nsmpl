import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AudioWaveform,
  Disc3,
  FileDown,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  Sliders,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { SimplePool } from "nostr-tools";
import { FileBrowser } from "./components/FileBrowser";
// IdentityPanel is intentionally NOT imported here — the file is
// kept around as a parked module for a future account / key-switcher
// surface. Identity for the everyday flow now lives in NostrPanel
// (logged-out view) and the header KeyRound chip (logged-in forget).
import { Player, type PlayerHandle } from "./components/Player";
import { clearIdentity } from "./lib/nostr";
import { NostrPanel } from "./components/NostrPanel";
import { InfoPanel } from "./components/InfoPanel";
import { BounceStatus, type BounceView } from "./components/BounceStatus";
import type { AudioFile, AudioInfo } from "./lib/tauri";
import { renderMix } from "./lib/tauri";
import { loadIdentity, type Identity } from "./lib/nostr";
import { cn } from "./lib/cn";

const THEME_KEY = "smpl-tool.theme";
const DENSITY_KEY = "smpl-tool.density";
const TRACKS_VISIBLE_KEY = "smpl-tool.tracksVisible";
const TRACK_PATHS_KEY = "smpl-tool.tracks.paths";
const TRACK_EXPANDED_KEY = "smpl-tool.tracks.expanded";
const EDITS_EXPANDED_KEY = "smpl-tool.editsExpanded";
const LIBRARY_EXPANDED_KEY = "smpl-tool.library.expanded";
const PROFILE_RELAYS = ["wss://relay.fizx.uk"];
type Theme = "fizx" | "upleb";
type Density = "super-slim" | "slim" | "wide";
type TracksVisible = 1 | 2;

function loadDensity(): Density {
  const v = localStorage.getItem(DENSITY_KEY);
  return v === "wide" || v === "super-slim" ? v : "slim";
}
function loadTracksVisible(): TracksVisible {
  return localStorage.getItem(TRACKS_VISIBLE_KEY) === "1" ? 1 : 2;
}
function loadTrackExpanded(): [boolean, boolean] {
  try {
    const raw = localStorage.getItem(TRACK_EXPANDED_KEY);
    if (!raw) return [true, true];
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "boolean" &&
      typeof parsed[1] === "boolean"
    ) {
      return parsed as [boolean, boolean];
    }
  } catch {
    /* fallthrough */
  }
  return [true, true];
}

function loadPersistedTrackPaths(): [string | null, string | null] {
  try {
    const raw = localStorage.getItem(TRACK_PATHS_KEY);
    if (!raw) return [null, null];
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      (typeof parsed[0] === "string" || parsed[0] === null) &&
      (typeof parsed[1] === "string" || parsed[1] === null)
    ) {
      return parsed as [string | null, string | null];
    }
  } catch {
    /* fallthrough */
  }
  return [null, null];
}

interface ProfileMeta {
  name?: string;
  display_name?: string;
  nip05?: string;
}

function loadTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY);
  return v === "upleb" ? "upleb" : "fizx";
}

function shortNpub(npub: string): string {
  if (npub.length < 16) return npub;
  return `${npub.slice(0, 12)}…${npub.slice(-4)}`;
}

type TrackIdx = 0 | 1;
type TrackPair<T> = [T, T];

export default function App() {
  // Per-track state. FileBrowser clicks route to `focused`, and the
  // InfoPanel + NostrPanel read from the focused slot too.
  const [files, setFiles] = useState<TrackPair<AudioFile | null>>([null, null]);
  const [audioInfos, setAudioInfos] = useState<TrackPair<AudioInfo | null>>([
    null,
    null,
  ]);
  const [focused, setFocused] = useState<TrackIdx>(0);
  // Bumped after each successful edit (trim/prune) — drives FileBrowser
  // to re-list the current dir so the new file surfaces without a
  // manual refresh.
  const [editCount, setEditCount] = useState(0);
  const [identity, setIdentity] = useState<Identity | null>(null);
  // Surfaces any failure from the loadIdentity → Rust get_identity
  // call so we can actually see what's going wrong on the
  // intermittent "doesn't remember nsec" complaint, instead of
  // silently nulling.
  const [identityLoadError, setIdentityLoadError] = useState<string | null>(
    null,
  );
  const [profile, setProfile] = useState<ProfileMeta | null>(null);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [density, setDensity] = useState<Density>(loadDensity);
  const [tracksVisible, setTracksVisible] = useState<TracksVisible>(loadTracksVisible);
  const [editsExpanded, setEditsExpanded] = useState<boolean>(
    () => localStorage.getItem(EDITS_EXPANDED_KEY) === "1",
  );
  const [libraryExpanded, setLibraryExpanded] = useState<boolean>(
    // Default true on a fresh install; user can collapse mid-session.
    () => localStorage.getItem(LIBRARY_EXPANDED_KEY) !== "0",
  );
  // The currently-loaded library directory, lifted out of FileBrowser so the
  // Sample panel can show a selected file's path relative to it — the de-facto
  // "root" until the suite roots manifest lands (see ndisc terrain-roots note).
  const [libDir, setLibDir] = useState("");
  // Horizontal collapse of the two flanks — when a flank is closed it renders
  // as a thin strip and the grid hands its width to the Library. Persisted.
  const [sampleOpen, setSampleOpen] = useState(
    () => localStorage.getItem("smpl-tool.sample.open") !== "0",
  );
  const [publishOpen, setPublishOpen] = useState(
    () => localStorage.getItem("smpl-tool.publish.open") !== "0",
  );
  useEffect(() => {
    localStorage.setItem("smpl-tool.sample.open", sampleOpen ? "1" : "0");
  }, [sampleOpen]);
  useEffect(() => {
    localStorage.setItem("smpl-tool.publish.open", publishOpen ? "1" : "0");
  }, [publishOpen]);
  // Bottom-row columns: a collapsed flank shrinks to a 2.5rem strip and the
  // Library (centre) absorbs the freed width.
  const bottomCols =
    !sampleOpen && !publishOpen
      ? "lg:grid-cols-[2.5rem_minmax(0,2.2fr)_2.5rem]"
      : !sampleOpen
        ? "lg:grid-cols-[2.5rem_minmax(0,2.2fr)_minmax(0,1fr)]"
        : !publishOpen
          ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,2.2fr)_2.5rem]"
          : "lg:grid-cols-[minmax(0,1fr)_minmax(0,2.2fr)_minmax(0,1fr)]";
  useEffect(() => {
    localStorage.setItem(LIBRARY_EXPANDED_KEY, libraryExpanded ? "1" : "0");
  }, [libraryExpanded]);
  const [trackExpanded, setTrackExpanded] =
    useState<TrackPair<boolean>>(loadTrackExpanded);
  function toggleTrackExpanded(i: TrackIdx) {
    setTrackExpanded((prev) => {
      const next: TrackPair<boolean> = [...prev] as typeof prev;
      next[i] = !next[i];
      return next;
    });
  }
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(DENSITY_KEY, density);
  }, [density]);
  useEffect(() => {
    localStorage.setItem(TRACKS_VISIBLE_KEY, String(tracksVisible));
  }, [tracksVisible]);
  useEffect(() => {
    localStorage.setItem(EDITS_EXPANDED_KEY, editsExpanded ? "1" : "0");
  }, [editsExpanded]);
  useEffect(() => {
    localStorage.setItem(TRACK_EXPANDED_KEY, JSON.stringify(trackExpanded));
  }, [trackExpanded]);

  // Persist current track file paths whenever they change.
  useEffect(() => {
    const paths = [files[0]?.path ?? null, files[1]?.path ?? null];
    localStorage.setItem(TRACK_PATHS_KEY, JSON.stringify(paths));
  }, [files]);

  // Restore Track 1/2 file selections on the first library listing.
  // Skipped if either track is already populated (user picked
  // something before the listing arrived, or restore already ran).
  const persistedTrackPaths = useRef(loadPersistedTrackPaths());
  const restoreTried = useRef(false);
  function handleListing(listing: AudioFile[]) {
    if (restoreTried.current) return;
    if (files[0] || files[1]) {
      restoreTried.current = true;
      return;
    }
    const paths = persistedTrackPaths.current;
    if (!paths[0] && !paths[1]) {
      restoreTried.current = true;
      return;
    }
    const byPath = new Map(listing.map((f) => [f.path, f] as const));
    const restored: TrackPair<AudioFile | null> = [
      paths[0] ? byPath.get(paths[0]) ?? null : null,
      paths[1] ? byPath.get(paths[1]) ?? null : null,
    ];
    if (restored[0] || restored[1]) setFiles(restored);
    restoreTried.current = true;
  }

  function pickTracksVisible(n: TracksVisible) {
    setTracksVisible(n);
    if (n === 1 && focused === 1) setFocused(0);
  }

  // Imperative refs to each Player for the between-tracks "master"
  // transport (play/stop/cue both at once).
  const player0Ref = useRef<PlayerHandle>(null);
  const player1Ref = useRef<PlayerHandle>(null);
  // Aggregate playing state — drives the master Play/Pause toggle.
  // A visible track's flip is reported via onPlayingChange.
  const [trackPlaying, setTrackPlaying] = useState<TrackPair<boolean>>([
    false,
    false,
  ]);
  function setTrackPlayingFor(i: TrackIdx, p: boolean) {
    setTrackPlaying((prev) => {
      const next: TrackPair<boolean> = [...prev] as typeof prev;
      next[i] = p;
      return next;
    });
  }
  const anyPlaying =
    trackPlaying[0] || (tracksVisible === 2 && trackPlaying[1]);

  // ---- Master time = loop position --------------------------------
  // Polls each Player's playhead-within-loop via the imperative
  // handle. Naturally resets when the loop wraps (currentTime jumps
  // back to region.start → position back to 0). Display freezes
  // when nothing is playing because the rAF only runs then.
  const [masterTime, setMasterTime] = useState(0);
  const masterRafRef = useRef(0);
  useEffect(() => {
    if (anyPlaying) {
      const tick = () => {
        // Prefer whichever track is actively progressing. We use
        // "non-zero" as a cheap proxy for "this track is the one
        // moving" — for matched-loop pairs in sync they're equal,
        // and the prefer-Track-0 fallback is harmless.
        const p0 = player0Ref.current?.getLoopPosition() ?? 0;
        const p1 = player1Ref.current?.getLoopPosition() ?? 0;
        setMasterTime(p0 > 0 ? p0 : p1);
        masterRafRef.current = requestAnimationFrame(tick);
      };
      masterRafRef.current = requestAnimationFrame(tick);
    }
    return () => {
      if (masterRafRef.current) {
        cancelAnimationFrame(masterRafRef.current);
        masterRafRef.current = 0;
      }
    };
  }, [anyPlaying]);
  async function handleForgetIdentity() {
    if (
      !confirm(
        "Forget this nsec from the OS keychain? Make sure you've backed it up.",
      )
    ) {
      return;
    }
    try {
      await clearIdentity();
      setIdentity(null);
    } catch (e) {
      alert(`Could not clear keychain entry: ${e}`);
    }
  }

  function togglePlayBoth() {
    if (anyPlaying) {
      player0Ref.current?.pause();
      player1Ref.current?.pause();
    } else {
      player0Ref.current?.play();
      player1Ref.current?.play();
    }
  }
  function stopBoth() {
    player0Ref.current?.stop();
    player1Ref.current?.stop();
    // Both seek to region.start (or 0); loop position = 0.
    setMasterTime(0);
  }
  function cueBoth() {
    player0Ref.current?.cue();
    player1Ref.current?.cue();
    // Cue forces playheads to file 0; clamp the display to match
    // (rAF is paused at this point, so explicit set is needed).
    setMasterTime(0);
  }

  // Hard reset of both WaveSurfer instances. Recovers from any
  // wedged audio-engine state (e.g. play/pause stops responding) by
  // destroying + recreating each player from its current file.
  // Preserves file selection, fade values, match toggle, and volume.
  // Loop regions are lost (they live inside WaveSurfer).
  function resetMaster() {
    player0Ref.current?.reset();
    player1Ref.current?.reset();
    setMasterTime(0);
  }

  // Master mute — silences both tracks regardless of their per-track
  // mute state (effective mute on each Player is `trackMuted ||
  // masterMuted`). Session-only — never persisted to avoid a
  // confusing "why is everything silent on launch?" failure mode.
  const [masterMuted, setMasterMuted] = useState(false);

  // ---- Bounce / render mix ----------------------------------------
  // 4-state operation model so the UI can show a discrete signal for
  // start (idle → running), progress (elapsed ticker), finished
  // (auto-fading "saved" line), and stopped (persistent error).
  // Shared state because only one bounce runs at a time and both the
  // MasterStrip and the per-Track Bounce surface read it.
  type BounceState =
    | { status: "idle" }
    | { status: "running"; startAt: number }
    | { status: "done"; path: string }
    | { status: "failed"; error: string };
  const [bounce, setBounce] = useState<BounceState>({ status: "idle" });
  const [bounceElapsedMs, setBounceElapsedMs] = useState(0);

  // Tick elapsed time while a bounce is in flight. Sub-second renders
  // for short loops will barely show motion, but the ticker still
  // gives an honest "is the process alive" signal for longer mixes.
  useEffect(() => {
    if (bounce.status !== "running") {
      setBounceElapsedMs(0);
      return;
    }
    const startAt = bounce.startAt;
    setBounceElapsedMs(Date.now() - startAt);
    const id = window.setInterval(() => {
      setBounceElapsedMs(Date.now() - startAt);
    }, 50);
    return () => window.clearInterval(id);
  }, [bounce]);

  // Auto-fade the "done" confirmation back to idle after a few seconds.
  // Errors stay until the next attempt — losing them silently would
  // hide failures the user needs to fix (missing region, permission
  // denied, etc.).
  useEffect(() => {
    if (bounce.status !== "done") return;
    const id = window.setTimeout(() => {
      setBounce({ status: "idle" });
    }, 4000);
    return () => window.clearTimeout(id);
  }, [bounce]);

  function mixInputFromPlayer(idx: TrackIdx, src: string): {
    src: string;
    region: [number, number] | null;
    fadeInSec: number;
    fadeOutSec: number;
    targetLenSec: number | null;
  } {
    const handle = idx === 0 ? player0Ref.current : player1Ref.current;
    const r = handle?.getLoopRange();
    const fades = handle?.getFades() ?? { fadeInSec: 0, fadeOutSec: 0 };
    const wantMatch = handle?.getMatchOther() ?? false;
    // Match target = the OTHER track's file duration. Region-aware
    // matching would need lifted region state — first cut keeps the
    // semantics simple ("make this track as long as the other's
    // file"). Caller only invokes mixInputFromPlayer for tracks with
    // files, but the other track may or may not be loaded.
    const otherIdx: TrackIdx = idx === 0 ? 1 : 0;
    const otherLen = audioInfos[otherIdx]?.duration ?? null;
    const targetLenSec =
      wantMatch && otherLen != null && otherLen > 0 ? otherLen : null;
    return {
      src,
      region: r ? [r.start, r.end] : null,
      fadeInSec: fades.fadeInSec,
      fadeOutSec: fades.fadeOutSec,
      targetLenSec,
    };
  }

  async function bounceMaster() {
    if (bounce.status === "running") return;
    const srcA = files[0]?.path;
    const srcB = files[1]?.path;
    if (!srcA || !srcB) {
      setBounce({ status: "failed", error: "master bounce needs both tracks loaded" });
      return;
    }
    setBounce({ status: "running", startAt: Date.now() });
    try {
      const path = await renderMix(
        mixInputFromPlayer(0, srcA),
        mixInputFromPlayer(1, srcB),
      );
      // editCount bump triggers FileBrowser reload so the new mix
      // appears in Library without a manual refresh.
      setEditCount((n) => n + 1);
      setBounce({ status: "done", path });
    } catch (e) {
      setBounce({ status: "failed", error: String(e) });
    }
  }

  async function bounceTrack(idx: TrackIdx) {
    if (bounce.status === "running") return;
    const src = files[idx]?.path;
    if (!src) {
      setBounce({ status: "failed", error: `track ${idx + 1} has no file loaded` });
      return;
    }
    setBounce({ status: "running", startAt: Date.now() });
    try {
      const path = await renderMix(mixInputFromPlayer(idx, src), null);
      setEditCount((n) => n + 1);
      setBounce({ status: "done", path });
    } catch (e) {
      setBounce({ status: "failed", error: String(e) });
    }
  }

  // Snapshot the bounce state plus the live elapsed counter into a
  // single value the child surfaces can render uniformly.
  const bounceView: BounceView =
    bounce.status === "running"
      ? { status: "running", elapsedMs: bounceElapsedMs }
      : bounce;

  function loadIntoFocused(f: AudioFile) {
    setFiles((prev) => {
      const next: TrackPair<AudioFile | null> = [...prev] as typeof prev;
      next[focused] = f;
      return next;
    });
  }
  function setAudioInfoFor(i: TrackIdx, info: AudioInfo | null) {
    setAudioInfos((prev) => {
      const next: TrackPair<AudioInfo | null> = [...prev] as typeof prev;
      next[i] = info;
      return next;
    });
  }

  const focusedFile = files[focused];
  const focusedAudioInfo = audioInfos[focused];

  // Apply + persist theme.
  useEffect(() => {
    document.documentElement.classList.toggle("theme-upleb", theme === "upleb");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // Resolve app version once.
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

  // Hydrate identity from the OS keychain on mount. Capture the
  // error rather than swallow it silently — surfaced in the
  // NostrPanel logged-out view so the user can see why hydration
  // failed instead of just landing on a logged-out screen with no
  // explanation.
  useEffect(() => {
    loadIdentity()
      .then((id) => {
        setIdentity(id);
        setIdentityLoadError(null);
      })
      .catch((e) => {
        setIdentity(null);
        setIdentityLoadError(String(e));
        console.error("loadIdentity failed:", e);
      });
  }, []);

  // Best-effort kind:0 profile fetch for display_name / name.
  useEffect(() => {
    if (!identity) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const pool = new SimplePool();
        const event = await pool.get(PROFILE_RELAYS, {
          kinds: [0],
          authors: [identity.pk],
        });
        pool.close(PROFILE_RELAYS);
        if (cancelled || !event) return;
        try {
          setProfile(JSON.parse(event.content) as ProfileMeta);
        } catch {
          /* malformed metadata, ignore */
        }
      } catch {
        /* best-effort fetch, ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity?.pk]);

  return (
    <div className="min-h-screen p-6 max-w-[1500px] mx-auto flex flex-col gap-4">
      <header className="rounded-lg bg-panel border border-surface/60 px-4 py-3
                         grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setTheme((t) => (t === "fizx" ? "upleb" : "fizx"))}
            title={
              theme === "fizx"
                ? "Theme: fizx.uk — click to switch to upleb.uk"
                : "Theme: upleb.uk — click to switch to fizx.uk"
            }
            aria-label="Switch colour theme"
            className="text-2xl font-bold tracking-tight leading-none shrink-0
                       cursor-pointer transition-opacity hover:opacity-70"
          >
            <span className="text-accent">n</span>
            <span className="text-mauve">smpl</span>
          </button>
          {appVersion && (
            <span
              className="hidden md:inline-flex items-center px-2.5 py-2
                         rounded-md bg-surface text-mauve font-mono text-xs
                         shrink-0"
            >
              v{appVersion}
            </span>
          )}
        </div>

        {/* Master Control — moved up into the header's centre column (where
            the publish-spec notes used to sit). Transport · counter · mute ·
            bounce read as the top bar's focal point. 2-track only; single
            track has nothing to master, so the centre stays empty. */}
        {tracksVisible === 2 ? (
          <MasterStrip
            playing={anyPlaying}
            time={masterTime}
            onTogglePlay={togglePlayBoth}
            onStop={stopBoth}
            onCue={cueBoth}
            onBounce={bounceMaster}
            bounceView={bounceView}
            onReset={resetMaster}
            muted={masterMuted}
            onToggleMute={() => setMasterMuted((p) => !p)}
          />
        ) : (
          <span aria-hidden="true" />
        )}

        {/* View + tracks selectors — right column of the header grid.
            justify-self-end pins them to the right edge of their
            grid track. */}
        <div className="hidden md:flex items-center gap-2 shrink-0 justify-self-end">
          <Segmented
            label="wave"
            icon={<AudioWaveform size={14} />}
            value={density}
            options={[
              { value: "super-slim", label: "super" },
              { value: "slim", label: "slim" },
              { value: "wide", label: "wide" },
            ]}
            onChange={setDensity}
          />
          <Segmented
            label="decks"
            icon={<Disc3 size={14} />}
            value={tracksVisible}
            options={[
              { value: 1, label: "1" },
              { value: 2, label: "2" },
            ]}
            onChange={pickTracksVisible}
          />
          <button
            type="button"
            onClick={() => setEditsExpanded((p) => !p)}
            aria-pressed={editsExpanded}
            title={
              editsExpanded
                ? "Hide the destructive-edits row (Trim/Prune/Gain/Fade) on each Track"
                : "Show the destructive-edits row (Trim/Prune/Gain/Fade) on each Track"
            }
            className={
              "px-2.5 py-2 rounded-md text-xs font-mono inline-flex items-center gap-1.5 transition-colors " +
              (editsExpanded
                ? "bg-mauve text-bg"
                : "bg-surface text-muted hover:text-mauve hover:bg-mauve/15")
            }
          >
            <Sliders size={12} />
            edits
          </button>
          {/* Forget-identity chip — only rendered when logged in
              (matches ndisc's header pattern). Sign-in lives in the
              Publish · Nostr panel where the KeyRound icon sits. */}
          {identity && (
            <button
              type="button"
              onClick={handleForgetIdentity}
              title="Signed in — click to forget the nsec from the OS keychain"
              aria-label="Forget identity"
              className="px-2.5 py-2 rounded-md text-xs font-mono inline-flex items-center gap-1.5 transition-colors bg-mauve text-bg hover:bg-mauve/80 cursor-pointer"
            >
              <LogOut size={12} />
            </button>
          )}
        </div>
      </header>

      {/* Tracks fill the full body width — Library moved out to the
          bottom row's middle slot, so there's no left column to balance
          anymore. content-start so sections stay intrinsic-height and
          extra column space falls below the last card rather than
          distributing across rows. */}
      <div className="grid grid-cols-1 gap-4 content-start">
        <Player
          ref={player0Ref}
          file={files[0]}
          label="1"
          focused={tracksVisible === 2 && focused === 0}
          onFocus={() => setFocused(0)}
          onAudioInfo={(i) => setAudioInfoFor(0, i)}
          onEdited={() => setEditCount((n) => n + 1)}
          onPlayingChange={(p) => setTrackPlayingFor(0, p)}
          density={density}
          editsExpanded={editsExpanded}
          expanded={trackExpanded[0]}
          onToggleExpand={() => toggleTrackExpanded(0)}
          otherDuration={
            tracksVisible === 2 ? audioInfos[1]?.duration ?? null : null
          }
          otherLabel="2"
          /* Per-track Bounce surfaces only in single-track mode; in
             2-track mode the MasterStrip's Bounce mixes both. */
          onBounce={tracksVisible === 1 ? () => bounceTrack(0) : undefined}
          bounceView={tracksVisible === 1 ? bounceView : undefined}
          masterMuted={masterMuted}
        />
        {tracksVisible === 2 && (
          <Player
            ref={player1Ref}
            file={files[1]}
            label="2"
            focused={focused === 1}
            onFocus={() => setFocused(1)}
            onAudioInfo={(i) => setAudioInfoFor(1, i)}
            onEdited={() => setEditCount((n) => n + 1)}
            onPlayingChange={(p) => setTrackPlayingFor(1, p)}
            density={density}
            editsExpanded={editsExpanded}
            expanded={trackExpanded[1]}
            onToggleExpand={() => toggleTrackExpanded(1)}
            otherDuration={audioInfos[0]?.duration ?? null}
            otherLabel="1"
            masterMuted={masterMuted}
          />
        )}
      </div>

      {/* Bottom-row chip strip — Sample / Library / Publish. Library is the
          dominant column so the deep artist/release/file list breathes; Sample
          + Publish flank it at equal (tightened) width. items-stretch makes the
          expanded flanks match Library's height; a content-collapsed panel
          opts out with self-start so it stays short. */}
      <div
        className={`grid grid-cols-1 gap-4 items-stretch ${bottomCols}`}
      >
        <InfoPanel
          file={focusedFile}
          audioInfo={focusedAudioInfo}
          rootDir={libDir}
          collapsed={!sampleOpen}
          onToggleCollapsed={() => setSampleOpen((o) => !o)}
        />
        <FileBrowser
          onSelect={loadIntoFocused}
          selected={focusedFile}
          reloadKey={editCount}
          onListing={handleListing}
          onDir={setLibDir}
          expanded={libraryExpanded}
          onToggleExpand={() => setLibraryExpanded((p) => !p)}
          density={density}
        />
        <NostrPanel
          file={focusedFile}
          identity={identity}
          setIdentity={setIdentity}
          identityLoadError={identityLoadError}
          collapsed={!publishOpen}
          onToggleCollapsed={() => setPublishOpen((o) => !o)}
        />
      </div>

      <footer className="rounded-lg bg-panel border border-surface/60 px-4 py-2
                         grid grid-cols-3 items-center gap-4
                         text-xs text-muted">
        <span className="truncate">stack: Tauri 2 + React + TS + Tailwind</span>

        {/* Identity chip — centered slot in the 3-column footer
            grid. justify-self-center keeps the chip true-centered
            even though the right column is now empty (stack on the
            left has narrower content than nothing on the right
            would otherwise allow under justify-between flex). */}
        <span className="justify-self-center min-w-0">
          {identity ? (
            <span className="inline-flex items-center gap-2 min-w-0">
              {(profile?.display_name || profile?.name) && (
                <span className="text-fg/80 truncate">
                  {profile?.display_name || profile?.name}
                </span>
              )}
              <span className="font-mono text-mauve" title={identity.npub}>
                {shortNpub(identity.npub)}
              </span>
              <span
                className="inline-flex items-center gap-1 text-ok"
                title="signed in · nsec stored in OS keychain (libsecret on Linux)"
              >
                <Lock size={11} />
                <span>nsec stored in keychain</span>
              </span>
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1.5 text-muted/80"
              title="No key in the OS keychain for this build. Load or generate one in the Publish panel."
            >
              <KeyRound size={11} className="opacity-60" />
              <span>not signed in · no key in keychain</span>
            </span>
          )}
        </span>

        {/* Nostr event-kinds vestige — relocated from the old header spec
            block. A condensed reminder of what smpl publishes, parked in the
            footer's right column. */}
        <span className="hidden md:inline-flex items-center gap-2 justify-self-end min-w-0 font-mono text-[10px] text-muted/70">
          <span className="text-mauve">Nostr</span>
          <span className="text-accent shrink-0">kind 1063</span>
          <span className="truncate">NIP-94 · 96 · 98</span>
        </span>

      </footer>
    </div>
  );
}

function fmtMasterTime(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00.000";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

function MasterStrip({
  playing,
  time,
  onCue,
  onTogglePlay,
  onStop,
  onBounce,
  bounceView,
  onReset,
  muted,
  onToggleMute,
}: {
  playing: boolean;
  time: number;
  onCue: () => void;
  onTogglePlay: () => void;
  onStop: () => void;
  onBounce: () => void;
  bounceView: BounceView;
  onReset: () => void;
  muted: boolean;
  onToggleMute: () => void;
}) {
  const bounceBusy = bounceView.status === "running";
  // Header-scaled controls: the master now lives inline in the top bar's
  // centre column (not a standalone card), so buttons + counter are sized to
  // a header row. Transport > utility > bounce, same tonal language as before.
  const transportBtn =
    "h-9 w-9 rounded-md bg-surface text-mauve hover:bg-mauve/15 " +
    "transition-colors flex items-center justify-center shrink-0";
  const utilityBtn =
    "h-8 w-8 rounded-md transition-colors " +
    "flex items-center justify-center shrink-0";
  const bounceBtn =
    "h-9 px-3 rounded-md bg-surface text-auburn hover:bg-auburn/15 " +
    "transition-colors flex items-center gap-1.5 shrink-0 " +
    "disabled:opacity-50 disabled:cursor-not-allowed";
  return (
    <div className="flex items-center justify-center gap-2">
      {/* Transport — Cue → Play/Pause → Stop, grouped as one unit. */}
      <div className="inline-flex gap-1">
        <button
          type="button"
          onClick={onCue}
          title="Cue both — pause both tracks and seek to start"
          aria-label="Cue both tracks"
          className={transportBtn}
        >
          <SkipBack size={16} fill="currentColor" />
        </button>
        <button
          type="button"
          onClick={onTogglePlay}
          title={playing ? "Pause both tracks" : "Play both tracks"}
          aria-label={playing ? "Pause both tracks" : "Play both tracks"}
          aria-pressed={playing}
          className={transportBtn}
        >
          {playing ? (
            <Pause size={16} fill="currentColor" />
          ) : (
            <Play size={16} fill="currentColor" />
          )}
        </button>
        <button
          type="button"
          onClick={onStop}
          title="Stop both tracks (pauses, returns each to its region start or 0)"
          aria-label="Stop both tracks"
          className={transportBtn}
        >
          <Square size={16} fill="currentColor" />
        </button>
      </div>

      {/* Recovery — Reset (danger-tinted, set apart from transport). */}
      <button
        type="button"
        onClick={() => {
          if (
            confirm(
              "Reset both tracks?\n\nThis recreates the audio engines for both decks. " +
                "File selection, fades and match are preserved. Loop regions are cleared.",
            )
          ) {
            onReset();
          }
        }}
        title="Reset both audio engines — safety net if a track stops responding to play/stop"
        aria-label="Reset both tracks"
        className={cn(utilityBtn, "bg-surface text-alert hover:bg-alert/15")}
      >
        <RotateCcw size={15} />
      </button>

      {/* Master loop counter — header-scaled (xl), inline. */}
      <span
        className="px-1 text-center font-mono font-bold text-xl text-ok tabular-nums tracking-tight"
        title="Master loop position — playhead time within the current loop; resets when the loop wraps and on Cue."
      >
        {fmtMasterTime(time)}
      </span>

      {/* Master mute — global OR over the per-track mutes. */}
      <button
        type="button"
        onClick={onToggleMute}
        title={
          muted
            ? "Master mute on — both tracks silenced. Click to unmute."
            : "Mute both tracks (master). Per-track mute states are preserved."
        }
        aria-label={muted ? "Unmute both tracks" : "Mute both tracks"}
        aria-pressed={muted}
        className={cn(
          utilityBtn,
          muted
            ? "bg-alert/20 text-alert hover:bg-alert/30"
            : "bg-surface text-mauve hover:bg-mauve/15",
        )}
      >
        {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
      </button>

      {/* Output — Bounce + its single-line status inline to the right so the
          whole cluster stays on the header's one row. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBounce}
          disabled={bounceBusy}
          title="Bounce mix — render both tracks' loop regions to a fresh WAV next to Track 1's source"
          aria-label="Bounce mix to WAV"
          className={bounceBtn}
        >
          {bounceBusy ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <FileDown size={16} />
          )}
          <span className="text-[11px] font-mono uppercase tracking-wide">
            bounce
          </span>
        </button>
        <BounceStatus view={bounceView} align="left" />
      </div>
    </div>
  );
}

function Segmented<T extends string | number>({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  // `label` is used for tooltip + a11y; not rendered visibly when an
  // icon prefix is supplied.
  label: string;
  icon?: ReactNode;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {icon ? (
        <span
          className="text-muted/70 inline-flex items-center"
          title={label}
          aria-label={label}
        >
          {icon}
        </span>
      ) : (
        <span className="hidden lg:inline text-muted/70 text-[10px] uppercase tracking-wide">
          {label}
        </span>
      )}
      <span className="inline-flex rounded-md overflow-hidden bg-surface">
        {options.map((opt, i) => (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            title={`${label}: ${opt.label}`}
            className={
              "px-2.5 py-2 text-xs font-mono transition-colors " +
              (i > 0 ? "border-l border-bg/40 " : "") +
              (value === opt.value
                ? "bg-mauve text-bg"
                : "text-muted hover:text-mauve hover:bg-mauve/15")
            }
          >
            {opt.label}
          </button>
        ))}
      </span>
    </span>
  );
}
