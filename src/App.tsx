import { useEffect, useState } from "react";
import { FileBrowser } from "./components/FileBrowser";
import { Player } from "./components/Player";
import { EditPanel } from "./components/EditPanel";
import { NostrPanel } from "./components/NostrPanel";
import { InfoPanel } from "./components/InfoPanel";
import type { AudioFile, AudioInfo } from "./lib/tauri";
import { loadIdentity, type Identity } from "./lib/nostr";

export default function App() {
  const [selected, setSelected] = useState<AudioFile | null>(null);
  const [audioInfo, setAudioInfo] = useState<AudioInfo | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);

  // Load saved nsec on mount.
  useEffect(() => {
    setIdentity(loadIdentity());
  }, []);

  return (
    <div className="min-h-screen p-6 max-w-[1400px] mx-auto">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-accent tracking-tight">
          smpl<span className="text-fg">-tool</span>
        </h1>
        <p className="text-sm text-muted mt-1">
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

      <footer className="mt-8 text-xs text-muted">
        <span>scaffold · stack: Tauri 2 + React + TypeScript + Tailwind</span>
      </footer>
    </div>
  );
}
