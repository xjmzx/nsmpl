import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AudioWaveform,
  Box,
  Disc3,
  KeyRound,
  Lock,
  LogOut,
  Pause,
  Play,
  SkipBack,
  Sliders,
  Square,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { SimplePool } from "nostr-tools";
import { FileBrowser } from "./components/FileBrowser";
// IdentityPanel is intentionally NOT imported here — the file is
// kept around as a parked module for a future account / key-switcher
// surface. Identity for the everyday flow now lives in NostrPanel
// (logged-out view) and the header KeyRound chip (logged-in forget).
import { Player, type PlayerHandle } from "./components/Player";
import { Section } from "./components/Section";
import { clearIdentity } from "./lib/nostr";
import { NostrPanel } from "./components/NostrPanel";
import { InfoPanel } from "./components/InfoPanel";
import type { AudioFile, AudioInfo } from "./lib/tauri";
import { loadIdentity, type Identity } from "./lib/nostr";

const THEME_KEY = "smpl-tool.theme";
const DENSITY_KEY = "smpl-tool.density";
const TRACKS_VISIBLE_KEY = "smpl-tool.tracksVisible";
const TRACK_PATHS_KEY = "smpl-tool.tracks.paths";
const TRACK_EXPANDED_KEY = "smpl-tool.tracks.expanded";
const EDITS_EXPANDED_KEY = "smpl-tool.editsExpanded";
const LIBRARY_EXPANDED_KEY = "smpl-tool.library.expanded";
const AUX_EXPANDED_KEY = "smpl-tool.aux.expanded";
const PROFILE_RELAYS = ["wss://relay.fizx.uk"];
type Theme = "fizx" | "upleb";
type Density = "slim" | "wide";
type TracksVisible = 1 | 2;

function loadDensity(): Density {
  return localStorage.getItem(DENSITY_KEY) === "wide" ? "wide" : "slim";
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
  useEffect(() => {
    localStorage.setItem(LIBRARY_EXPANDED_KEY, libraryExpanded ? "1" : "0");
  }, [libraryExpanded]);
  const [auxExpanded, setAuxExpanded] = useState<boolean>(
    () => localStorage.getItem(AUX_EXPANDED_KEY) !== "0",
  );
  useEffect(() => {
    localStorage.setItem(AUX_EXPANDED_KEY, auxExpanded ? "1" : "0");
  }, [auxExpanded]);
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
            className="text-3xl font-bold tracking-tight leading-none shrink-0
                       cursor-pointer transition-opacity hover:opacity-70"
          >
            <span className="text-accent">n</span>
            <span className="text-fg">disc</span>
            <span className="text-mauve">.smpl</span>
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

        {/* Publish spec — sits in the centre column of the 3-col
            grid (1fr_auto_1fr), so it's true-centred against the
            full header width regardless of the side widths. */}
        <div
          className="hidden md:flex items-center min-w-0
                     text-xs leading-snug whitespace-nowrap overflow-hidden"
        >
          <span className="text-mauve font-mono mr-2 shrink-0">Nostr</span>
          <span className="font-mono text-accent shrink-0">kind 1063</span>
          <span className="text-fg/70 shrink-0">
            {" "}
            (NIP94 file metadata){" "}
          </span>
          <span className="text-fg/70 shrink-0">tags: </span>
          <span className="font-mono text-accent shrink-0">
            url, m, x, size, title
          </span>
          <span className="text-fg/70 shrink-0"> auth: </span>
          <span className="font-mono text-accent shrink-0">NIP-98</span>
          <span className="text-fg/70 shrink-0"> (27235). Upload: </span>
          <span className="font-mono text-accent shrink-0">NIP-96</span>
        </div>

        {/* View + tracks selectors — right column of the header grid.
            justify-self-end pins them to the right edge of their
            grid track. */}
        <div className="hidden md:flex items-center gap-2 shrink-0 justify-self-end">
          <Segmented
            label="wave"
            icon={<AudioWaveform size={14} />}
            value={density}
            options={[
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

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2 items-stretch">
        {/* Left column: Library (elastic — grows into spare column
            height when adjacent panels collapse or when the right
            column is taller) on top, Sample info below (intrinsic
            height). Flex column with h-full so it can stretch into
            the items-stretch row from the outer grid. */}
        <div className="flex flex-col gap-4 h-full min-h-0">
          <FileBrowser
            onSelect={loadIntoFocused}
            selected={focusedFile}
            reloadKey={editCount}
            onListing={handleListing}
            expanded={libraryExpanded}
            onToggleExpand={() => setLibraryExpanded((p) => !p)}
          />
          <InfoPanel file={focusedFile} audioInfo={focusedAudioInfo} />
          {/* aux — placeholder panel that sits visually opposite
              Publish in the right column. min-h only applies when
              expanded so collapsing shrinks the panel to just its
              title (like every other collapsible). */}
          <Section
            title="aux"
            icon={<Box size={16} />}
            onTitleClick={() => setAuxExpanded((p) => !p)}
            className={
              auxExpanded
                ? "border-muted/40 min-h-[20rem]"
                : "border-muted/40 min-h-[5rem]"
            }
          >
            {auxExpanded && (
              <p className="text-xs text-muted/60 italic">
                placeholder — no function wired yet
              </p>
            )}
          </Section>
        </div>

        {/* Right column: two tracks + publish. FileBrowser clicks load
            into whichever track is focused (ring-highlighted). `content-start`
            stops the grid from distributing extra column height across rows,
            so sections are intrinsic-height and don't grow empty space below
            their content; any leftover height ends up below the last card. */}
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
          />
          {tracksVisible === 2 && (
            <>
              <MasterStrip
                playing={anyPlaying}
                density={density}
                time={masterTime}
                onTogglePlay={togglePlayBoth}
                onStop={stopBoth}
                onCue={cueBoth}
              />
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
              />
            </>
          )}
          <NostrPanel
            file={focusedFile}
            identity={identity}
            setIdentity={setIdentity}
            identityLoadError={identityLoadError}
          />
        </div>
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

        {/* Right column placeholder — keeps the 3-col grid balanced
            without inserting visible filler. */}
        <span aria-hidden="true" />

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
  density,
  time,
  onCue,
  onTogglePlay,
  onStop,
}: {
  playing: boolean;
  density: Density;
  time: number;
  onCue: () => void;
  onTogglePlay: () => void;
  onStop: () => void;
}) {
  // Match the per-Track transport chip padding so master + track
  // buttons align horizontally row to row.
  const btn = density === "slim" ? "px-2.5 py-1.5 text-xs" : "px-3 py-2";
  // Card padding mirrors Section's (p-3 slim, p-4 wide) so the
  // buttons inside the master card sit at the same x as the
  // per-track transport chip inside its Section.
  const cardPad = density === "slim" ? "p-3" : "p-4";
  // Colours reversed from before: dark fill, mauve glyph (was
  // mauve fill, dark glyph). Sits inside a full-width card that
  // matches the Section card chrome rather than the old extending
  // thin bar.
  const masterBtn =
    btn +
    " rounded-md bg-surface text-mauve hover:bg-mauve/15 transition-colors" +
    " flex items-center justify-center";
  return (
    <div
      className={`rounded-xl bg-panel border border-ok/30 shadow-md ${cardPad} flex items-center justify-between gap-3 min-h-[5rem]`}
    >
      <div className="inline-flex gap-1">
        <button
          type="button"
          onClick={onCue}
          title="Cue both — pause both tracks and seek to start"
          aria-label="Cue both tracks"
          className={masterBtn}
        >
          <SkipBack size={14} fill="currentColor" />
        </button>
        <button
          type="button"
          onClick={onTogglePlay}
          title={playing ? "Pause both tracks" : "Play both tracks"}
          aria-label={playing ? "Pause both tracks" : "Play both tracks"}
          aria-pressed={playing}
          className={masterBtn}
        >
          {playing ? (
            <Pause size={14} fill="currentColor" />
          ) : (
            <Play size={14} fill="currentColor" />
          )}
        </button>
        <button
          type="button"
          onClick={onStop}
          title="Stop both tracks (pauses, returns each to its region start or 0)"
          aria-label="Stop both tracks"
          className={masterBtn}
        >
          <Square size={14} fill="currentColor" />
        </button>
      </div>
      {/* Master loop counter — large, bold, deck-display feel.
          tabular-nums keeps the digits from jittering as the rAF
          ticks at sub-ms speed. */}
      <span
        className="font-mono font-bold text-3xl text-ok tabular-nums tracking-tight"
        title="Master loop position — playhead time within the current loop; resets when the loop wraps and on Cue."
      >
        {fmtMasterTime(time)}
      </span>
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
