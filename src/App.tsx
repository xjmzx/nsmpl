import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { FileBrowser } from "./components/FileBrowser";
import { Player } from "./components/Player";
import { EditPanel } from "./components/EditPanel";
import { NostrPanel } from "./components/NostrPanel";
import { InfoPanel } from "./components/InfoPanel";
import type { AudioFile, AudioInfo } from "./lib/tauri";
import { loadIdentity, type Identity } from "./lib/nostr";

const THEME_KEY = "smpl-tool.theme";
type Theme = "fizx" | "upleb";

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
  const [identity, setIdentity] = useState<Identity | null>(null);
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

  return (
    <div className="min-h-screen p-6 max-w-[1400px] mx-auto flex flex-col gap-4">
      <header className="flex items-start justify-between gap-4">
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
            className="text-3xl font-bold text-accent tracking-tight
                       leading-none shrink-0 cursor-pointer transition-opacity
                       hover:opacity-70"
          >
            smpl<span className="text-fg">-tool</span>
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
          <FileBrowser onSelect={setSelected} selected={selected} />
          <InfoPanel
            identity={identity}
            setIdentity={setIdentity}
            file={selected}
            audioInfo={audioInfo}
          />
        </div>

        {/* Right column: player, edit, publish */}
        <div className="grid grid-cols-1 gap-4">
          <Player file={selected} onAudioInfo={setAudioInfo} />
          <EditPanel />
          <NostrPanel file={selected} identity={identity} />
        </div>
      </div>

      <footer className="mt-4 flex flex-wrap items-center justify-between
                          gap-x-8 gap-y-1 text-xs text-muted">
        <span>scaffold · stack: Tauri 2 + React + TypeScript + Tailwind</span>
        {identity && (
          <span className="inline-flex items-center gap-2 min-w-0">
            <span className="font-mono text-mauve" title={identity.npub}>
              {shortNpub(identity.npub)}
            </span>
            <span
              className="inline-flex items-center gap-1"
              title="secret key stored in OS keychain (libsecret on Linux)"
            >
              <Lock size={11} />
              <span>nsec in keychain</span>
            </span>
          </span>
        )}
      </footer>
    </div>
  );
}
