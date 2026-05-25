import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Section } from "./Section";
import { listAudioFiles, type AudioFile } from "../lib/tauri";
import { cn } from "../lib/cn";

interface FileBrowserProps {
  onSelect?: (file: AudioFile) => void;
  selected?: AudioFile | null;
  // Bump this from the parent to force a re-list of the current dir
  // (used after a trim so the new file appears). Initial value 0 is
  // ignored so the browser doesn't reload before the user picks a dir.
  reloadKey?: number;
}

const DIR_KEY = "smpl-tool.lib.dir";
const SORT_KEY = "smpl-tool.lib.sort";

type SortKey = "name" | "size" | "modified";
type SortDir = "asc" | "desc";
type Sort = { key: SortKey; dir: SortDir };

const DEFAULT_SORT: Sort = { key: "name", dir: "asc" };

function loadSort(): Sort {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (!raw) return DEFAULT_SORT;
    const parsed = JSON.parse(raw);
    const keyOk =
      parsed.key === "name" ||
      parsed.key === "size" ||
      parsed.key === "modified";
    const dirOk = parsed.dir === "asc" || parsed.dir === "desc";
    return keyOk && dirOk ? parsed : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtModified(unixSec: number): string {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  const now = new Date();
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
  });
}

// Three-column grid shared by header + rows so the headers line up with
// their values.
const GRID_CLS = "grid grid-cols-[1fr_5rem_5rem] gap-3 items-center";

export function FileBrowser({ onSelect, selected, reloadKey }: FileBrowserProps) {
  const [dir, setDir] = useState(() => localStorage.getItem(DIR_KEY) ?? "");
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<Sort>(loadSort);

  async function loadDir(path: string) {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const items = await listAudioFiles(path);
      setFiles(items);
      setDir(path);
      localStorage.setItem(DIR_KEY, path);
    } catch (e) {
      setError(String(e));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }

  // Auto-load on mount if a previous dir is remembered.
  useEffect(() => {
    if (dir) loadDir(dir);
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist sort preference across sessions.
  useEffect(() => {
    localStorage.setItem(SORT_KEY, JSON.stringify(sort));
  }, [sort]);

  // Parent-triggered reload (e.g. after a trim writes a new file).
  useEffect(() => {
    if (!reloadKey || !dir) return;
    loadDir(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  async function browse() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose samples folder",
      defaultPath: dir || undefined,
    });
    if (typeof picked === "string") loadDir(picked);
  }

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }

  const sortedFiles = useMemo(() => {
    const arr = [...files];
    arr.sort((a, b) => {
      let v: number;
      if (sort.key === "name") {
        v = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      } else if (sort.key === "size") {
        v = a.size - b.size;
      } else {
        v = a.modified - b.modified;
      }
      return sort.dir === "asc" ? v : -v;
    });
    return arr;
  }, [files, sort]);

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
          onClick={browse}
          disabled={loading}
          className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                     text-fg disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center gap-1.5"
          title="Browse for folder"
        >
          <FolderOpen size={14} />
          Browse
        </button>
        <button
          onClick={() => loadDir(dir)}
          disabled={loading || !dir}
          className="px-3 py-2 rounded-md bg-surface hover:bg-surfaceHover
                     text-fg disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center"
          title="Reload"
          aria-label="Reload"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <p className="mt-2 text-xs text-alert font-mono break-all">{error}</p>
      )}

      <div className="mt-1 rounded-md bg-bg/50 overflow-hidden flex flex-col">
        <div
          className={cn(
            GRID_CLS,
            "px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted",
            "border-b border-surface/60",
          )}
        >
          <SortHeader label="name" k="name" sort={sort} onToggle={toggleSort} />
          <SortHeader
            label="size"
            k="size"
            sort={sort}
            onToggle={toggleSort}
            align="right"
          />
          <SortHeader
            label="modified"
            k="modified"
            sort={sort}
            onToggle={toggleSort}
            align="right"
          />
        </div>

        <ul className="max-h-72 overflow-auto divide-y divide-surface/60">
          {sortedFiles.length === 0 && !loading && !error && (
            <li className="px-3 py-3 text-muted text-xs">
              No directory loaded. Click Browse, or type a path and press Enter.
            </li>
          )}
          {sortedFiles.map((f) => (
            <li
              key={f.path}
              onClick={() => onSelect?.(f)}
              className={cn(
                GRID_CLS,
                "px-3 py-2 text-xs font-mono cursor-pointer",
                "hover:bg-surface/40",
                selected?.path === f.path && "bg-surface/70 text-accent",
              )}
              title={f.path}
            >
              <span className="truncate">{f.name}</span>
              <span className="text-muted text-right shrink-0">
                {fmtSize(f.size)}
              </span>
              <span className="text-muted text-right shrink-0">
                {fmtModified(f.modified)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function SortHeader({
  label,
  k,
  sort,
  onToggle,
  align = "left",
}: {
  label: string;
  k: SortKey;
  sort: Sort;
  onToggle: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      onClick={() => onToggle(k)}
      title={`Sort by ${label}`}
      className={cn(
        "inline-flex items-center gap-0.5 hover:text-fg transition-colors",
        align === "right" ? "justify-end" : "justify-start",
        active && "text-accent",
      )}
    >
      <span>{label}</span>
      {active &&
        (sort.dir === "asc" ? (
          <ChevronUp size={10} />
        ) : (
          <ChevronDown size={10} />
        ))}
    </button>
  );
}
