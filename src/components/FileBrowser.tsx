import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Globe,
  Home,
  Music,
  Radio,
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
  clipsRoot,
  folderCoverage,
  listAudioFiles,
  listLeafFolders,
  releasedRels,
  type AudioFile,
  type ClipCoverage,
  type FolderEntry,
} from "../lib/tauri";
import { cn } from "../lib/cn";
import { ClipBar, CoverageBar } from "./CoverageBar";

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
// Per-app roots for the three suite dirs (option 2 — no shared-manifest change).
// Clips uses the manifest `home`; Source + Web are these persisted per-app paths.
const SRC_ROOT_KEY = "smpl-tool.root.source";
const WEB_ROOT_KEY = "smpl-tool.root.web";
const DEFAULT_SOURCE_ROOT = "/data/music";
const DEFAULT_CLIPS_ROOT = "/data/music_clips";
const DEFAULT_WEB_ROOT = "/data/music_clips_comp";
const SORT_KEY = "smpl-tool.lib.sort";
const RECENT_KEY = "smpl-tool.lib.recent";

/** How many of each we surface. Two is the ask, and it's the right number —
 *  more and the strip competes with the list it exists to serve. */
const RECENT_SHOWN = 2;
/** Keep a few more than we show, so dipping into a third artist and back
 *  doesn't evict the pair you were actually working between. */
const RECENT_KEPT = 6;

/** A directory the user has browsed, classified by its depth under the clips
 *  root: one level down is an ARTIST, two or more is a RELEASE (a multi-disc
 *  set surfaces `Artist/Release/Disc 1`, which is still the release you were
 *  in). The root itself is neither — that's what Home is for. */
type RecentKind = "artist" | "release";
interface Recent {
  path: string;
  label: string;
  kind: RecentKind;
}

function loadRecents(): Recent[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? (JSON.parse(raw) as Recent[]) : [];
    return Array.isArray(arr) ? arr.filter((r) => r?.path && r?.kind) : [];
  } catch {
    return [];
  }
}

function classify(path: string, root: string | null): Recent | null {
  if (!root) return null;
  const r = root.replace(/\/+$/, "");
  if (!path.startsWith(r + "/")) return null;
  const parts = path.slice(r.length + 1).split("/").filter(Boolean);
  if (parts.length === 0) return null; // the root itself — Home covers it
  return {
    path,
    label: parts[parts.length - 1],
    kind: parts.length === 1 ? "artist" : "release",
  };
}

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
const GRID_CLS = "grid grid-cols-[1fr_5rem_5rem_5rem] gap-3 items-center";
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
  // Source (music) + Web (Opus) roots — the two per-app quick-jump targets that
  // complement the manifest-derived Clips `home`. Shift-click their toolbar
  // buttons to re-point them.
  const [sourceRoot, setSourceRoot] = useState(
    () => localStorage.getItem(SRC_ROOT_KEY) ?? DEFAULT_SOURCE_ROOT,
  );
  const [webRoot, setWebRoot] = useState(
    () => localStorage.getItem(WEB_ROOT_KEY) ?? DEFAULT_WEB_ROOT,
  );
  const [files, setFiles] = useState<AudioFile[]>([]);
  // Folder mode: the loaded dir held no direct audio, so we list its leaf
  // folders (release-grain, artist/release columns + has-audio dot) instead of
  // a file list. Clicking a folder drills in to its files (flat mode).
  const [folderMode, setFolderMode] = useState(false);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [audioFilter, setAudioFilter] = useState<"all" | "has" | "none">("all");
  // Releases ndisc has published (relpaths under the library root). null = no
  // manifest exported — the filter is simply not offered, rather than offered
  // and matching nothing.
  const [released, setReleased] = useState<Set<string> | null>(null);
  const [releasedFilter, setReleasedFilter] = useState(false);
  // Home = the clip tree's root, from the suite roots manifest (not hardcoded).
  const [home, setHome] = useState<string | null>(null);
  // Per-clip coverage for the OPEN folder — clip length ÷ resolved source
  // length, probed live on folder-open (header-only ffprobe, no scan). Keyed by
  // clip path; cached per folder so revisits are free.
  const [coverage, setCoverage] = useState<Map<string, ClipCoverage>>(new Map());
  const coverageCache = useRef<Map<string, ClipCoverage[]>>(new Map());
  const coverageDirRef = useRef("");
  const [recents, setRecents] = useState<Recent[]>(loadRecents);
  useEffect(() => {
    clipsRoot()
      .then((h) => {
        setHome(h);
        // Fresh install (nothing persisted) → land on the FLAC clips tree,
        // the default working set. A returning user keeps their last dir.
        if (!localStorage.getItem(DIR_KEY)) loadDir(h ?? DEFAULT_CLIPS_ROOT);
      })
      .catch(() => setHome(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    releasedRels()
      .then((r) => setReleased(r ? new Set(r) : null))
      .catch(() => setReleased(null));
  }, []);

  // The clip tree mirrors the source tree, so a clip folder's rel IS the
  // release's rel — but walk UP as well, because a multi-disc release surfaces
  // its CD folders as the leaves ("Artist/Release/Disc 1") while the manifest
  // names the release ("Artist/Release").
  const inReleased = useCallback(
    (rel: string) => {
      if (!released) return false;
      let p = rel;
      while (p) {
        if (released.has(p)) return true;
        const i = p.lastIndexOf("/");
        if (i < 0) break;
        p = p.slice(0, i);
      }
      return false;
    },
    [released],
  );
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
  // loadDir is a plain function re-created each render, but it can be called
  // from effects that closed over an older one — read `home` through a ref so a
  // listing never classifies against a stale root.
  const homeRef = useRef(home);
  homeRef.current = home;

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
      // Coverage bars for the open folder — probe clip + source durations live.
      // Fire-and-forget so the listing shows immediately; bars fill in when the
      // header-only ffprobe returns. Guard so a stale folder can't overwrite a
      // newer one that resolved first.
      coverageDirRef.current = path;
      if (items.length > 0) {
        const cached = coverageCache.current.get(path);
        if (cached) {
          setCoverage(new Map(cached.map((c) => [c.path, c])));
        } else {
          setCoverage(new Map());
          folderCoverage(path)
            .then((rows) => {
              coverageCache.current.set(path, rows);
              if (coverageDirRef.current === path) {
                setCoverage(new Map(rows.map((c) => [c.path, c])));
              }
            })
            .catch(() => {});
        }
      } else {
        setCoverage(new Map());
      }
      setDir(path);
      localStorage.setItem(DIR_KEY, path);
      // Remember where we've been. Newest first, deduped by path — so
      // re-entering a folder promotes it rather than duplicating it.
      const rec = classify(path, homeRef.current);
      if (rec) {
        setRecents((prev) => {
          const next = [rec, ...prev.filter((r) => r.path !== rec.path)].slice(
            0,
            RECENT_KEPT,
          );
          localStorage.setItem(RECENT_KEY, JSON.stringify(next));
          return next;
        });
      }
      onListingRef.current?.(items);
      onDirRef.current?.(path);
    } catch (e) {
      setError(String(e));
      setFiles([]);
      setFolders([]);
      setFolderMode(false);
      setCoverage(new Map());
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

  // Shift-click a root button → pick + persist that root, then jump to it.
  async function pickRoot(which: "source" | "web") {
    const cur = which === "source" ? sourceRoot : webRoot;
    const picked = await open({
      directory: true,
      multiple: false,
      title:
        which === "source"
          ? "Set the source library root"
          : "Set the web (Opus) clips root",
      defaultPath: cur || undefined,
    });
    if (typeof picked !== "string") return;
    if (which === "source") {
      setSourceRoot(picked);
      localStorage.setItem(SRC_ROOT_KEY, picked);
    } else {
      setWebRoot(picked);
      localStorage.setItem(WEB_ROOT_KEY, picked);
    }
    loadDir(picked);
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
      if (releasedFilter && !inReleased(f.rel)) return false;
      return true;
    });
  }, [folders, query, audioFilter, releasedFilter, inReleased]);

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
      <div className="flex items-center gap-2">
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
        {/* Root switcher — a set of three quick-jumps across the suite dirs,
            acting on the path field to their left. Clips is the manifest home
            (source resolution + coverage read from it); Source and Web are
            per-app roots (shift-click a button to re-point it). The active view
            is inverted so the current tree reads at a glance. */}
        <div className="flex gap-0.5">
          <button
            onClick={(e) => (e.shiftKey ? pickRoot("source") : loadDir(sourceRoot))}
            disabled={loading || !sourceRoot}
            className={cn(
              "rounded-md flex items-center",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              dir === sourceRoot
                ? "bg-accent text-bg"
                : "bg-surface hover:bg-surfaceHover text-fg",
              D.control,
            )}
            title={`Source library (${sourceRoot}) — click to go · shift-click to set`}
            aria-label="Source library root"
          >
            <Music size={14} />
          </button>
          <button
            onClick={() => home && loadDir(home)}
            disabled={loading || !home}
            className={cn(
              "rounded-md flex items-center",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              dir === home
                ? "bg-accent text-bg"
                : "bg-surface hover:bg-surfaceHover text-fg",
              D.control,
            )}
            title={
              home
                ? `Clips — the FLAC clip tree root (${home})`
                : "No clips root in the suite roots manifest"
            }
            aria-label="Clips — clip tree root"
          >
            <Home size={14} />
          </button>
          <button
            onClick={(e) => (e.shiftKey ? pickRoot("web") : loadDir(webRoot))}
            disabled={loading || !webRoot}
            className={cn(
              "rounded-md flex items-center",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              dir === webRoot
                ? "bg-accent text-bg"
                : "bg-surface hover:bg-surfaceHover text-fg",
              D.control,
            )}
            title={`Web (Opus) clips (${webRoot}) — click to go · shift-click to set`}
            aria-label="Web/Opus clips root"
          >
            <Globe size={14} />
          </button>
        </div>
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

      {/* Where you've been. Two artists and two releases — enough to pivot
          between the pair you're actually working across, without the strip
          competing with the list it exists to serve. Artists are digital-tinted
          (the Library's own colour), releases accent. */}
      {(() => {
        const artists = recents
          .filter((r) => r.kind === "artist")
          .slice(0, RECENT_SHOWN);
        const releases = recents
          .filter((r) => r.kind === "release")
          .slice(0, RECENT_SHOWN);
        if (!artists.length && !releases.length) return null;
        const chip = (r: Recent, tone: string) => (
          <button
            key={r.path}
            onClick={() => loadDir(r.path)}
            disabled={loading || dir === r.path}
            title={r.path}
            className={cn(
              "px-1.5 py-0.5 rounded max-w-[10rem] truncate transition-colors",
              "disabled:opacity-40 disabled:cursor-default",
              tone,
            )}
          >
            {r.label}
          </button>
        );
        return (
          <div className="flex items-center gap-1.5 text-[10px] font-mono flex-wrap">
            {artists.length > 0 && (
              <>
                <span className="text-muted/70 uppercase tracking-wide">artists</span>
                {artists.map((r) =>
                  chip(r, "bg-digital/15 text-digital hover:bg-digital/25"),
                )}
              </>
            )}
            {releases.length > 0 && (
              <>
                <span className="text-muted/70 uppercase tracking-wide ml-1">
                  releases
                </span>
                {releases.map((r) =>
                  chip(r, "bg-accent/15 text-accent hover:bg-accent/25"),
                )}
              </>
            )}
          </div>
        );
      })()}

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

          {/* ndisc-released scope. Only rendered when a manifest exists — a
              control that silently matches nothing is worse than no control.
              This is read-only awareness of ndisc's discography; nsmpl records
              no publish state of its own. */}
          {released && (
            <button
              type="button"
              onClick={() => setReleasedFilter((v) => !v)}
              aria-pressed={releasedFilter}
              title={
                releasedFilter
                  ? `Showing only clips inside the ${released.size.toLocaleString()} releases ndisc has published to Nostr (kind:31237). Click to clear.`
                  : `Show only clips inside the ${released.size.toLocaleString()} releases ndisc has published to Nostr (kind:31237).`
              }
              className={cn(
                "ml-auto flex items-center gap-1 h-7 px-2 rounded-md transition-colors",
                releasedFilter
                  ? "bg-mauve/20 text-mauve"
                  : "bg-surface text-muted hover:text-fg",
              )}
            >
              <Radio size={12} />
              released
            </button>
          )}
        </div>
      )}

      {/* Fills the section's elastic children area. The old max-h-[20rem]
          capped the list at ~10 rows no matter how much height was available —
          which is exactly what made browsing a 2,455-folder clip tree painful.
          It now grows to the section, and the list scrolls inside. */}
      <div className="mt-1 rounded-md bg-bg/50 overflow-hidden flex flex-col flex-1 min-h-[10rem]">
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
              <span
                className="flex items-center"
                title="clip coverage of this folder"
              >
                <CoverageBar rows={[...coverage.values()]} />
              </span>
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
                  <ClipBar cov={coverage.get(f.path)} />
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
