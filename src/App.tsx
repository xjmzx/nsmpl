import { useEffect, useState } from "react";
import { KeyRound, Lock } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { SimplePool } from "nostr-tools";
import { FileBrowser } from "./components/FileBrowser";
import { Player } from "./components/Player";
import { NostrPanel } from "./components/NostrPanel";
import { InfoPanel } from "./components/InfoPanel";
import type { AudioFile, AudioInfo } from "./lib/tauri";
import { loadIdentity, type Identity } from "./lib/nostr";

const THEME_KEY = "smpl-tool.theme";
const DENSITY_KEY = "smpl-tool.density";
const TRACKS_VISIBLE_KEY = "smpl-tool.tracksVisible";
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
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(DENSITY_KEY, density);
  }, [density]);
  useEffect(() => {
    localStorage.setItem(TRACKS_VISIBLE_KEY, String(tracksVisible));
  }, [tracksVisible]);

  function pickTracksVisible(n: TracksVisible) {
    setTracksVisible(n);
    if (n === 1 && focused === 1) setFocused(0);
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
                         flex items-start justify-between gap-4">
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
        <div className="hidden md:flex items-center flex-wrap gap-x-2 gap-y-1 text-xs text-muted mt-1">
          <span className="whitespace-nowrap">Publish samples to Nostr</span>
          <span className="text-surface/80">|</span>
          <span className="whitespace-nowrap">
            <span className="font-mono text-accent">kind 1063</span>{" "}
            <span className="text-fg/70">(NIP-94 — file metadata)</span>
          </span>
          <span className="text-surface/80">|</span>
          <span className="whitespace-nowrap">
            <span className="text-fg/70">tags: </span>
            <span className="font-mono text-accent">
              url, m, x, size, title
            </span>
          </span>
          <span className="text-surface/80">|</span>
          <span className="whitespace-nowrap">
            <span className="text-fg/70">auth: </span>
            <span className="font-mono text-accent">NIP-98</span>
            <span className="text-fg/70">
              {" "}
              (HTTP Auth, kind 27235). Upload:{" "}
            </span>
            <span className="font-mono text-accent">NIP-96</span>
          </span>
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
            file={files[0]}
            label="1"
            focused={tracksVisible === 2 && focused === 0}
            onFocus={() => setFocused(0)}
            onAudioInfo={(i) => setAudioInfoFor(0, i)}
            onEdited={() => setEditCount((n) => n + 1)}
            density={density}
          />
          {tracksVisible === 2 && (
            <Player
              file={files[1]}
              label="2"
              focused={focused === 1}
              onFocus={() => setFocused(1)}
              onAudioInfo={(i) => setAudioInfoFor(1, i)}
              onEdited={() => setEditCount((n) => n + 1)}
              density={density}
            />
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
        <div className="inline-flex items-center gap-3">
          <Segmented
            label="view"
            value={density}
            options={[
              { value: "slim", label: "slim" },
              { value: "wide", label: "wide" },
            ]}
            onChange={setDensity}
          />
          <Segmented
            label="tracks"
            value={tracksVisible}
            options={[
              { value: 1, label: "1" },
              { value: 2, label: "2" },
            ]}
            onChange={pickTracksVisible}
          />
        </div>

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

        {/* Focused-track sample chip on the right (or invisible
            placeholder so identity stays visually centered). */}
        {focusedFile ? (
          <span title={focusedFile.path}>
            <span className="text-mauve mr-1">T{focused + 1}</span>
            {focusedFile.name}
          </span>
        ) : (
          <span className="opacity-0">·</span>
        )}
      </footer>
    </div>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted/70 text-[10px] uppercase tracking-wide">
        {label}
      </span>
      <span className="inline-flex rounded-md overflow-hidden border border-surface/60">
        {options.map((opt, i) => (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            className={
              "px-2 py-0.5 text-[10px] transition-colors " +
              (i > 0 ? "border-l border-surface/60 " : "") +
              (value === opt.value
                ? "bg-accent/20 text-accent"
                : "text-muted hover:text-fg hover:bg-surface/40")
            }
          >
            {opt.label}
          </button>
        ))}
      </span>
    </span>
  );
}
