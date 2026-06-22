import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Film,
  FolderInput,
  FolderOpen,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Section } from "./Section";
import { LeafIcon, LeafDots } from "./LeafIcon";
import {
  listAudioFiles,
  listLeafFolders,
  type AudioFile,
  type FolderEntry,
} from "../lib/tauri";
import { cn } from "../lib/cn";

type Density = "super-slim" | "slim" | "wide";

// Density-dependent classNames. Mirrors the Player component's DENSITY
// map so the Library and the track panels scale together when the user
// toggles the global density selector.
// Matches Player's DENSITY map — Library steps section padding +
// control sizing in lockstep with the per-track Player. Heavier
// transforms (list container size, row text bumps) didn't read as
// well in practice; the right-column spacer in App.tsx now keeps the
// two-column heights consistent so Library doesn't have to do the
// heavy lifting on its own.
const DENSITY: Record<Density, {
  section: string;
  control: string;
}> = {
  // Lockstep with the Player's vertical diet — each tier one notch slimmer.
  "super-slim": {
    section: "p-1.5 gap-1",
    control: "px-2 py-0.5 text-[11px]",
  },
  slim: {
    section: "p-2 gap-1.5",
    control: "px-2 py-1 text-[11px]",
  },
  wide: {
    section: "p-3 gap-2",
    control: "px-2.5 py-1.5 text-xs",
  },
};

interface FileBrowserProps {
  onSelect?: (file: AudioFile) => void;
  selected?: AudioFile | null;
  // Bump this from the parent to force a re-list of the current dir
  // (used after a trim so the new file appears). Initial value 0 is
  // ignored so the browser doesn't reload before the user picks a dir.
  reloadKey?: number;
  // Fired after every successful directory listing — the parent uses
  // this to restore persisted Track 1 / Track 2 selections once the
  // library is back.
  onListing?: (files: AudioFile[]) => void;
  // Fired with the directory path after every successful listing — lets the
  // parent treat the loaded dir as the de-facto root for relative-path display.
  onDir?: (dir: string) => void;
  // Whole-panel collapse — when false, only the title bar renders.
  expanded?: boolean;
  /** Slim/wide density — matches the per-track Player's density so the
   *  Library compresses + expands in lockstep with the rest of the work
   *  area. Defaults to "slim" to stay consistent with the app default. */
  density?: Density;
  onToggleExpand?: () => void;
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
// Folder-mode grid: artist | release | leaf meter. The leaf meter doubles as
// the audio-presence cue — lit (green) leaves when the release holds audio,
// all-dim when it's a sampling gap — so no separate dot column is needed.
const FOLDER_GRID_CLS =
  "grid grid-cols-[1fr_1fr_3.5rem] gap-2 items-center";

// Split a folder rel ("Artist/Release[/Disc]") into artist + release columns.
function splitRel(rel: string): { artist: string; release: string } {
  const parts = rel.split("/");
  return {
    artist: parts[0] || rel,
    release: parts.slice(1).join("/"),
  };
}

export function FileBrowser({
  onSelect,
  selected,
  reloadKey,
  onListing,
  onDir,
  expanded = true,
  onToggleExpand,
  density = "slim",
}: FileBrowserProps) {
  const D = DENSITY[density];
  const [dir, setDir] = useState(() => localStorage.getItem(DIR_KEY) ?? "");
  const [files, setFiles] = useState<AudioFile[]>([]);
  // Folder mode: the loaded dir held no direct audio, so we list its leaf
  // folders (release-grain, artist/release columns + has-audio dot) instead of
  // a file list. Clicking a folder drills in to its files (flat mode).
  const [folderMode, setFolderMode] = useState(false);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [audioFilter, setAudioFilter] = useState<"all" | "has" | "none">("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<Sort>(loadSort);
  const [query, setQuery] = useState("");

  // Ref-pipe onListing so an unstable parent callback doesn't re-fire
  // the listing effect (or, in the worst case, cause an infinite loop).
  const onListingRef = useRef(onListing);
  onListingRef.current = onListing;
  const onDirRef = useRef(onDir);
  onDirRef.current = onDir;

  async function loadDir(path: string) {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      // Flat listing first; if the directory has no direct audio (e.g. the
      // user opened /data/music_clips at the artist level), fall back to its
      // leaf folders so the parent shows releases, not a flat clip dump.
      const items = await listAudioFiles(path);
      let folderList: FolderEntry[] = [];
      if (items.length === 0) {
        folderList = await listLeafFolders(path);
      }
      setFiles(items);
      setFolders(folderList);
      setFolderMode(folderList.length > 0);
      setDir(path);
      localStorage.setItem(DIR_KEY, path);
      onListingRef.current?.(items);
      onDirRef.current?.(path);
    } catch (e) {
      setError(String(e));
      setFiles([]);
      setFolders([]);
      setFolderMode(false);
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
    const q = query.trim().toLowerCase();
    const arr = q
      ? files.filter((f) => f.name.toLowerCase().includes(q))
      : [...files];
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
  }, [files, sort, query]);

  // Folder-mode rows: filtered by the search box (on rel) and the has/no-audio
  // toggle. Already sorted by rel from the backend.
  const shownFolders = useMemo(() => {
    const q = query.trim().toLowerCase();
    return folders.filter((f) => {
      if (q && !f.rel.toLowerCase().includes(q)) return false;
      if (audioFilter === "has" && f.audioCount === 0) return false;
      if (audioFilter === "none" && f.audioCount > 0) return false;
      return true;
    });
  }, [folders, query, audioFilter]);

  // Tally for the filter chips (over the search-filtered set).
  const folderTotals = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? folders.filter((f) => f.rel.toLowerCase().includes(q))
      : folders;
    const has = base.filter((f) => f.audioCount > 0).length;
    return { all: base.length, has, none: base.length - has };
  }, [folders, query]);

  // Navigate up one directory level (used to climb back out of a drilled-in
  // release folder to the release/audit view).
  function goUp() {
    const parent = dir.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
    if (parent) loadDir(parent);
  }

  const filterActive = query.trim().length > 0;
  const noMatches =
    filterActive && !folderMode && sortedFiles.length === 0;

  return (
    <Section
      title="Library"
      icon={<FolderOpen size={16} />}
      onTitleClick={onToggleExpand}
      elastic={expanded}
      className={cn(
        "border-digital/30",
        !expanded && "min-h-[5rem] self-start",
        D.section,
      )}
    >
      {!expanded ? (
        <p
          className="text-xs text-digital truncate font-mono"
          title={dir || ""}
        >
          {dir
            ? folderMode
              ? `${dir} · ${folders.length} release${folders.length === 1 ? "" : "s"}`
              : `${dir} · ${files.length} file${files.length === 1 ? "" : "s"}`
            : "no directory loaded"}
        </p>
      ) : (
        <>
      <div className="flex gap-2">
        <input
          type="text"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && loadDir(dir)}
          placeholder="/path/to/samples"
          className={cn(
            "flex-1 rounded-md bg-surface text-fg",
            "placeholder:text-muted outline-none border border-transparent",
            "focus:border-accent/50",
            D.control,
          )}
          spellCheck={false}
        />
        <button
          onClick={goUp}
          disabled={loading || !dir}
          className={cn(
            "rounded-md bg-surface hover:bg-surfaceHover",
            "text-fg disabled:opacity-50 disabled:cursor-not-allowed",
            "flex items-center",
            D.control,
          )}
          title="Up one folder"
          aria-label="Up one folder"
        >
          <FolderInput size={14} className="-scale-y-100" />
        </button>
        <button
          onClick={browse}
          disabled={loading}
          className={cn(
            "rounded-md bg-surface hover:bg-surfaceHover",
            "text-fg disabled:opacity-50 disabled:cursor-not-allowed",
            "flex items-center gap-1.5",
            D.control,
          )}
          title="Browse for folder"
        >
          <FolderOpen size={14} />
          Browse
        </button>
        <button
          onClick={() => loadDir(dir)}
          disabled={loading || !dir}
          className={cn(
            "rounded-md bg-surface hover:bg-surfaceHover",
            "text-fg disabled:opacity-50 disabled:cursor-not-allowed",
            "flex items-center",
            D.control,
          )}
          title="Reload"
          aria-label="Reload"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <p className="mt-2 text-xs text-alert font-mono break-all">{error}</p>
      )}

      {/* In-listing search — case-insensitive substring on filename. */}
      <div className="relative mt-2">
        <Search
          size={12}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            folderMode
              ? `Filter ${folders.length} releases…`
              : files.length > 0
                ? `Filter ${files.length} files…`
                : "Filter files…"
          }
          aria-label="Filter library"
          spellCheck={false}
          disabled={files.length === 0 && folders.length === 0}
          className="w-full pl-7 pr-7 py-1.5 rounded-md bg-surface text-fg text-xs
                     placeholder:text-muted outline-none border border-transparent
                     focus:border-accent/50 disabled:opacity-50"
        />
        {filterActive && (
          <button
            onClick={() => setQuery("")}
            title="Clear filter"
            aria-label="Clear filter"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-alert"
          >
            <X size={11} />
          </button>
        )}
      </div>

      {/* Folder-mode audio filter — a single cycling leaf toggle, the same
          control ndisc.tree uses: off → has audio (green) → no audio /
          sampling gaps (purple) → off. */}
      {folderMode && (
        <div className="mt-2 flex items-center gap-2 text-[10px]">
          {(() => {
            const next = { all: "has", has: "none", none: "all" } as const;
            const STATE = {
              all: {
                cls: "bg-surface text-muted hover:text-fg",
                title: `All ${folderTotals.all} releases. Click to show only releases with audio.`,
                label: "all releases",
              },
              has: {
                cls: "bg-accent text-bg",
                title: `${folderTotals.has} releases with audio. Click to show only sampling gaps.`,
                label: "with audio",
              },
              none: {
                cls: "bg-mauve text-bg",
                title: `${folderTotals.none} sampling gaps (no audio). Click to clear.`,
                label: "sampling gaps",
              },
            };
            const s = STATE[audioFilter];
            return (
              <>
                <button
                  type="button"
                  onClick={() => setAudioFilter(next[audioFilter])}
                  aria-pressed={audioFilter !== "all"}
                  aria-label="Audio filter"
                  title={s.title}
                  className={cn(
                    "flex items-center justify-center h-7 w-7 rounded-md transition-colors",
                    s.cls,
                  )}
                >
                  <LeafIcon size={18} className="rotate-[10deg]" />
                </button>
                <span className="text-muted">{s.label}</span>
              </>
            );
          })()}
        </div>
      )}

      {/* flex-1 lets this block fill the section's elastic children
          area when the column has spare height. min-h floor keeps it
          from collapsing below a few rows; max-h caps it at ~10
          visible rows (header + rows), beyond which the file list
          inside scrolls. */}
      <div className="mt-1 rounded-md bg-bg/50 overflow-hidden flex flex-col flex-1 min-h-[10rem] max-h-[20rem]">
        <div
          className={cn(
            folderMode ? FOLDER_GRID_CLS : GRID_CLS,
            "px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted",
            "border-b border-surface/60",
          )}
        >
          {folderMode ? (
            <>
              <span>artist</span>
              <span>release</span>
              <span className="flex justify-end">
                <LeafIcon size={11} className="rotate-[10deg]" />
              </span>
            </>
          ) : (
            <>
              <SortHeader
                label="name"
                k="name"
                sort={sort}
                onToggle={toggleSort}
              />
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
            </>
          )}
        </div>

        <ul className="flex-1 min-h-0 overflow-auto divide-y divide-surface/60">
          {folderMode ? (
            <>
              {shownFolders.length === 0 && !loading && !error && (
                <li className="px-3 py-3 text-muted text-xs">
                  No releases match.
                </li>
              )}
              {shownFolders.map((fld) => {
                const { artist, release } = splitRel(fld.rel);
                const hasAudio = fld.audioCount > 0;
                // A video-only folder isn't a sampling "gap" — don't dim it.
                const hasMedia = hasAudio || fld.videoCount > 0;
                return (
                  <li
                    key={fld.path}
                    onClick={() => loadDir(fld.path)}
                    className={cn(
                      FOLDER_GRID_CLS,
                      "px-3 py-2 text-xs font-mono cursor-pointer hover:bg-surface/40",
                      !hasMedia && "text-muted",
                    )}
                    title={
                      `${fld.path} · ${fld.audioCount} audio file${fld.audioCount === 1 ? "" : "s"}` +
                      (fld.videoCount > 0
                        ? ` · ${fld.videoCount} video file${fld.videoCount === 1 ? "" : "s"}`
                        : "")
                    }
                  >
                    <span className="truncate text-muted">{artist}</span>
                    <span className="truncate">{release}</span>
                    <span className="shrink-0 flex items-center justify-end gap-1.5">
                      {fld.videoCount > 0 && (
                        <span
                          className="inline-flex items-center gap-0.5 text-mauve"
                          title={`${fld.videoCount} video file${fld.videoCount === 1 ? "" : "s"}`}
                        >
                          <Film size={11} className="shrink-0" />
                          {fld.videoCount > 1 && (
                            <span className="text-[10px]">{fld.videoCount}</span>
                          )}
                        </span>
                      )}
                      <LeafDots
                        n={fld.audioCount}
                        unit="audio file"
                        maxCols={8}
                        maxRows={4}
                      />
                    </span>
                  </li>
                );
              })}
            </>
          ) : (
            <>
              {sortedFiles.length === 0 && !loading && !error && (
                <li className="px-3 py-3 text-muted text-xs">
                  {files.length === 0
                    ? "No directory loaded. Click Browse, or type a path and press Enter."
                    : noMatches
                      ? `No files match “${query.trim()}”.`
                      : "No files."}
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
                  title={f.isVideo ? `${f.path} · video` : f.path}
                >
                  <span className="truncate inline-flex items-center gap-1.5 min-w-0">
                    {f.isVideo && (
                      <Film
                        size={11}
                        className="shrink-0 text-mauve"
                        aria-label="video"
                      />
                    )}
                    <span className="truncate">{f.name}</span>
                  </span>
                  <span className="text-muted text-right shrink-0">
                    {fmtSize(f.size)}
                  </span>
                  <span className="text-muted text-right shrink-0">
                    {fmtModified(f.modified)}
                  </span>
                </li>
              ))}
            </>
          )}
        </ul>
      </div>
        </>
      )}
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
