import { useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Section } from "./Section";
import { listAudioFiles, type AudioFile } from "../lib/tauri";
import { cn } from "../lib/cn";

interface FileBrowserProps {
  onSelect?: (file: AudioFile) => void;
  selected?: AudioFile | null;
}

export function FileBrowser({ onSelect, selected }: FileBrowserProps) {
  const [dir, setDir] = useState("");
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadDir(path: string) {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const items = await listAudioFiles(path);
      setFiles(items);
      setDir(path);
    } catch (e) {
      setError(String(e));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Section title="Library" icon={<FolderOpen size={16} />}>
      <div className="flex gap-2">
        <input
          type="text"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && loadDir(dir)}
          placeholder="/path/to/samples"
          className="flex-1 px-3 py-2 rounded-md bg-surface text-fg
                     placeholder:text-muted outline-none border border-transparent
                     focus:border-accent/50"
          spellCheck={false}
        />
        <button
          onClick={() => loadDir(dir)}
          disabled={loading || !dir}
          className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                     text-fg disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center gap-1.5"
          title="Reload"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          Load
        </button>
      </div>

      {error && (
        <p className="mt-2 text-xs text-alert font-mono break-all">{error}</p>
      )}

      <ul className="mt-1 max-h-72 overflow-auto rounded-md
                     divide-y divide-surface/60 bg-bg/50">
        {files.length === 0 && !loading && !error && (
          <li className="px-3 py-3 text-muted text-xs">
            No directory loaded. Enter a path above and press Enter.
          </li>
        )}
        {files.map((f) => (
          <li
            key={f.path}
            onClick={() => onSelect?.(f)}
            className={cn(
              "px-3 py-2 text-xs font-mono cursor-pointer",
              "hover:bg-surface/40 flex justify-between gap-3",
              selected?.path === f.path && "bg-surface/70 text-accent",
            )}
            title={f.path}
          >
            <span className="truncate">{f.name}</span>
            <span className="text-muted shrink-0">
              {(f.size / 1024 / 1024).toFixed(1)} MB
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
