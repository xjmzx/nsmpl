import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  AudioWaveform,
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
  const [profile, setProfile] = useState<ProfileMeta | null>(null);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [density, setDensity] = useState<Density>(loadDensity);
  const [tracksVisible, setTracksVisible] = useState<TracksVisible>(loadTracksVisible);
  const [editsExpanded, setEditsExpanded] = useState<boolean>(
    () => localStorage.getItem(EDITS_EXPANDED_KEY) === "1",
  );
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
  }
  function cueBoth() {
    player0Ref.current?.cue();
    player1Ref.current?.cue();
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

  // Hydrate identity from the OS keychain on mount.
  useEffect(() => {
    loadIdentity()
      .then(setIdentity)
      .catch(() => setIdentity(null));
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
    <div className="min-h-screen p-6 max-w-[1400px] mx-auto flex flex-col gap-4">
      <header className="rounded-lg bg-panel border border-surface/60 px-4 py-3
                         flex items-center gap-4">
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

        {/* Publish spec — sits next to the title/version on the left.
            ml-auto on the selectors group pushes them to the right
            edge so the spec doesn't have to span the full width. */}
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

        {/* View + tracks selectors — far right, height matches the version
            chip. Square buttons with rounded corners, ndisc-styled.
            ml-auto pushes this whole group to the right edge so the
            publish spec on the left doesn't have to fill the gap. */}
        <div className="hidden md:flex items-center gap-2 shrink-0 ml-auto">
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

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 items-stretch">
        {/* Left column: library on top, sample info below. `content-start`
            keeps rows intrinsic-height (same pattern as the right column)
            so any leftover column height ends up below the last card,
            not as empty space inside one. */}
        <div className="grid grid-cols-1 gap-4 content-start">
          <FileBrowser
            onSelect={loadIntoFocused}
            selected={focusedFile}
            reloadKey={editCount}
            onListing={handleListing}
          />
          <InfoPanel file={focusedFile} audioInfo={focusedAudioInfo} />
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
          />
          {tracksVisible === 2 && (
            <>
              <MasterStrip
                playing={anyPlaying}
                density={density}
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
              />
            </>
          )}
          <NostrPanel
            file={focusedFile}
            identity={identity}
            setIdentity={setIdentity}
          />
        </div>
      </div>

      <footer className="rounded-lg bg-panel border border-surface/60 px-4 py-2
                         flex flex-wrap items-center justify-between
                         gap-x-8 gap-y-1 text-xs text-muted">
        <span>stack: Tauri 2 + React + TS + Tailwind</span>

        {/* Centered identity chip — same 3-chip pattern as ndisc /
            ndisc.blobtree. */}
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
            title="No key in the OS keychain for this build. Load or generate one in the Identity panel."
          >
            <KeyRound size={11} className="opacity-60" />
            <span>not signed in · no key in keychain</span>
          </span>
        )}

        {/* Right-edge spacer — keeps the identity chip visually
            centered in the footer without showing the focused-track
            filename (which already lives in each Track's title). */}
        <span className="opacity-0">·</span>
      </footer>
    </div>
  );
}

function MasterStrip({
  playing,
  density,
  onCue,
  onTogglePlay,
  onStop,
}: {
  playing: boolean;
  density: Density;
  onCue: () => void;
  onTogglePlay: () => void;
  onStop: () => void;
}) {
  // Match the per-Track transport chip padding so master + track
  // buttons align horizontally row to row.
  const btn = density === "slim" ? "px-2.5 py-1.5 text-xs" : "px-3 py-2";
  // Horizontal padding only — outer container matches the Track
  // Section's left/right padding so the buttons align column-to-
  // column with the per-track transport chip, but no extra
  // top/bottom thickness around the strip.
  const outerPad = density === "slim" ? "px-3" : "px-4";
  // Inter-button gap restored — Cue / Play-Pause / Stop are separate
  // rounded chips with a small space between, instead of one fused
  // segmented chip.
  const masterBtn =
    btn +
    " rounded-md bg-mauve text-bg hover:bg-mauve/80 transition-colors" +
    " flex items-center justify-center";
  return (
    <div className={`flex items-center gap-3 ${outerPad}`}>
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
      {/* Visible bar extending out from the buttons — muted so it
          doesn't compete with the mauve chip; flex-1 so it takes
          whatever horizontal space is left. */}
      <div
        aria-hidden="true"
        className="flex-1 h-1.5 bg-surface/70 rounded-full"
      />
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
