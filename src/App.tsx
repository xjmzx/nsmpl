import { useEffect, useState } from "react";
import { KeyRound, Lock } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { SimplePool } from "nostr-tools";
import { FileBrowser } from "./components/FileBrowser";
import { Player } from "./components/Player";
import { EditPanel } from "./components/EditPanel";
import { NostrPanel } from "./components/NostrPanel";
import { InfoPanel } from "./components/InfoPanel";
import type { AudioFile, AudioInfo } from "./lib/tauri";
import { loadIdentity, type Identity } from "./lib/nostr";

const THEME_KEY = "smpl-tool.theme";
const PROFILE_RELAYS = ["wss://relay.fizx.uk"];
type Theme = "fizx" | "upleb";

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

export default function App() {
  const [selected, setSelected] = useState<AudioFile | null>(null);
  const [audioInfo, setAudioInfo] = useState<AudioInfo | null>(null);
  const [regionRange, setRegionRange] = useState<
    { start: number; end: number } | null
  >(null);
  // Bumped after each successful edit (trim/prune) — drives FileBrowser
  // to re-list the current dir so the new file surfaces without a
  // manual refresh.
  const [editCount, setEditCount] = useState(0);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [profile, setProfile] = useState<ProfileMeta | null>(null);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [appVersion, setAppVersion] = useState<string | null>(null);

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
        <p className="text-sm text-muted mt-1 text-right hidden md:block">
          local samples · loop · edit · publish to Nostr · share via{" "}
          <a
            href="https://smpl.fizx.uk"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            smpl.fizx.uk
          </a>
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 items-stretch">
        {/* Left column: library on top, identity + sample info on bottom.
            Library at 3fr / Info at 5fr ⇒ Library is ~25% shorter vs. an
            even split (3/8 = 37.5% vs. 50%). */}
        <div className="grid grid-cols-1 grid-rows-[minmax(0,3fr)_minmax(0,5fr)] gap-4 min-h-[640px]">
          <FileBrowser
            onSelect={setSelected}
            selected={selected}
            reloadKey={editCount}
          />
          <InfoPanel
            identity={identity}
            setIdentity={setIdentity}
            file={selected}
            audioInfo={audioInfo}
          />
        </div>

        {/* Right column: player, edit, publish */}
        <div className="grid grid-cols-1 gap-4">
          <Player
            file={selected}
            onAudioInfo={setAudioInfo}
            onRegionChange={setRegionRange}
          />
          <EditPanel
            file={selected}
            region={regionRange}
            onEdited={() => setEditCount((n) => n + 1)}
          />
          <NostrPanel file={selected} identity={identity} />
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

        {/* Selected sample chip on the right (or invisible placeholder so
            identity stays visually centered). */}
        {selected ? (
          <span title={selected.path}>
            {selected.name}
          </span>
        ) : (
          <span className="opacity-0">·</span>
        )}
      </footer>
    </div>
  );
}
