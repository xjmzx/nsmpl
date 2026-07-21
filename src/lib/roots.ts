// The three suite roots, persisted per-app (the keys FileBrowser's switcher
// writes). Source = masters, Web = derived Opus copies, Clips = the editable
// FLAC working set. Read live from localStorage so this tracks whatever the
// switcher has been repointed to.
export const SRC_ROOT_KEY = "smpl-tool.root.source";
export const WEB_ROOT_KEY = "smpl-tool.root.web";
export const DEFAULT_SOURCE_ROOT = "/data/music";
export const DEFAULT_CLIPS_ROOT = "/data/music_clips";
export const DEFAULT_WEB_ROOT = "/data/music_clips_comp";

export function sourceRoot(): string {
  return localStorage.getItem(SRC_ROOT_KEY) ?? DEFAULT_SOURCE_ROOT;
}
export function webRoot(): string {
  return localStorage.getItem(WEB_ROOT_KEY) ?? DEFAULT_WEB_ROOT;
}

function under(path: string, root: string): boolean {
  const r = root.replace(/\/+$/, "");
  return !!r && (path === r || path.startsWith(r + "/"));
}

/**
 * Destructive edits (trim / prune / gain / pad) must never touch a SOURCE master
 * or a derived WEB (Opus) copy — only the FLAC clips are the working set. Returns
 * a short human reason when a path is off-limits, else null (editable).
 */
export function editGuardReason(path: string | null | undefined): string | null {
  if (!path) return null;
  if (under(path, sourceRoot())) return "source master";
  if (under(path, webRoot())) return "web (Opus) copy";
  return null;
}
