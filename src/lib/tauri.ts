import { invoke } from "@tauri-apps/api/core";

export interface AudioFile {
  path: string;
  name: string;
  size: number;
  modified: number; // unix seconds
  // Path relative to the listed root. Flat listing → just the filename;
  // deep listing → "artist/release/…/file" (split for the columns).
  rel: string;
  // True for a video (audio-visual) file rather than audio — the browser
  // lists it (full media spectrum) and marks it; smpl doesn't sample/play it.
  isVideo: boolean;
}

export interface AudioInfo {
  sampleRate: number;
  channels: number;
  duration: number; // seconds
}

export async function listAudioFiles(dir: string): Promise<AudioFile[]> {
  return invoke<AudioFile[]>("list_audio_files", { dir });
}

/// Recursive listing under `dir` (each file carries its `rel` path) so the
/// Library can browse a whole tree at the artist level, blobtree-style.
export async function listAudioFilesDeep(dir: string): Promise<AudioFile[]> {
  return invoke<AudioFile[]>("list_audio_files_deep", { dir });
}

/// A leaf folder (release-grain) with its direct audio count. `audioCount === 0`
/// marks a sampling gap — a release folder where no clips landed.
export interface FolderEntry {
  rel: string; // "Artist/Release" relative to the listed root
  path: string; // absolute, for drilling in
  audioCount: number;
  videoCount: number; // direct video files — marks releases carrying A/V
  discCount: number; // 1 normally; >1 for a multi-disc release (CD1/CD2/… collapsed)
}

/// List leaf folders under `dir` with audio counts — the folder-grain
/// "has audio / no audio" view for a parent dir (e.g. /data/music_clips).
export async function listLeafFolders(dir: string): Promise<FolderEntry[]> {
  return invoke<FolderEntry[]>("list_leaf_folders", { dir });
}

/// Does a path exist on disk? Used to offer the Opus web copy of a FLAC clip
/// at publish time only when it has actually been compressed.
export async function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

/// Resolution of a file against the shared suite roots manifest
/// (~/.config/ndisc-suite/roots.json). `root`/`rel` locate the file under a
/// named root; for a clip under a `mirrorOf` root, `sourcePath` is the
/// resolved source track (`sourceExists=false` ⇒ drift — source renamed/gone).
/// All fields null/false when the manifest is absent or the file is unmatched.
export interface SourceResolution {
  root: string | null;
  rel: string | null;
  sourcePath: string | null;
  sourceExists: boolean;
}

export async function resolveSource(path: string): Promise<SourceResolution> {
  return invoke<SourceResolution>("resolve_source", { path });
}

/// Per-clip duration coverage for a folder: each clip's own probed length and
/// its resolved source-track length (both null when unprobeable / unresolved).
/// Cheap header-only ffprobe, run live on folder-open — powers the clip-coverage
/// bars without a scan.
export interface ClipCoverage {
  path: string;
  clipSecs: number | null;
  sourceSecs: number | null;
  /** The clip's Opus web copy exists under the web root (compress-dest mirror).
   *  Drives the third coverage-by-type dot. */
  opusExists: boolean;
}

export async function folderCoverage(
  dir: string,
  webRoot?: string,
): Promise<ClipCoverage[]> {
  return invoke<ClipCoverage[]>("folder_coverage", { dir, webRoot });
}

/// Relpaths (under the library root) of the releases ndisc has published to
/// Nostr, read from the suite-shared manifest it exports. null = no manifest
/// has been exported, which is the ordinary cold state rather than an error.
///
/// nsmpl is READ-ONLY about this, and about Nostr publish state generally: it
/// edits audio, it does not own a publish lifecycle. Knowing what ndisc has
/// released is enough to scope the Library to the published discography.
export async function releasedRels(): Promise<string[] | null> {
  return invoke<string[] | null>("released_rels");
}

/// The suite-shared BPM store (~/.local/share/ndisc-suite/bpm.json).
/// Contract: nplay/schema/bpm-store-v1.md.
///
/// A BPM is recorded against the **source track**, not the clip: a clip is an
/// excerpt of a library track, so it's the same music at the same tempo, and
/// the source's (root, relpath) is the key the rest of the suite uses. `target`
/// is the path it actually landed on, so the UI can say what it did.

export interface BpmWrite {
  target: string;
  root: string;
  rel: string;
  bpm: number;
  written: boolean;
}

/// Persist the bar-derived BPM. This is a *human-asserted* value (you declared
/// the bar count; the tempo is exact arithmetic on a known loop length), so it
/// outranks anything aubio detected and nplay will not overwrite it.
export async function storeBarsBpm(
  path: string,
  bpm: number,
): Promise<BpmWrite> {
  return invoke<BpmWrite>("store_bars_bpm", { path, bpm });
}

export interface BpmKnown {
  bpm: number;
  /// "aubio" (detected — a guess) | "tap" | "bars" (human — ground truth).
  source: string;
  at: number;
  target: string;
}

/// What the suite already knows about this file's tempo, via its source track.
/// null = nothing known, which is the ordinary case rather than an error.
export async function knownBpm(path: string): Promise<BpmKnown | null> {
  return invoke<BpmKnown | null>("known_bpm", { path });
}

export async function readAudioFile(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_audio_file", { path });
}

/// Trim `src` to [start, end] seconds via ffmpeg stream-copy. Writes
/// `{stem}-trim.{ext}` next to the source (auto-suffixed on collision)
/// and resolves to the absolute output path.
export async function trimAudio(
  src: string,
  start: number,
  end: number,
): Promise<string> {
  return invoke<string>("trim_audio", { src, start, end });
}

/// Delete [start, end] from `src` and splice the remainder via ffmpeg's
/// concat demuxer (stream-copy). Writes `{stem}-prune.{ext}` next to
/// the source (auto-suffixed on collision) and resolves to the absolute
/// output path.
export async function pruneAudio(
  src: string,
  start: number,
  end: number,
): Promise<string> {
  return invoke<string>("prune_audio", { src, start, end });
}

/// Apply a linear-gain factor to the whole file via ffmpeg's volume
/// filter. `gain` is a linear multiplier (1.0 = unity, 0.5 ≈ -6 dB,
/// 2.0 ≈ +6 dB). Writes `{stem}-gain.{ext}` next to the source
/// (auto-suffixed on collision) and resolves to the absolute output
/// path.
export async function gainAudio(
  src: string,
  gain: number,
): Promise<string> {
  return invoke<string>("gain_audio", { src, gain });
}

/// Detect BPM via `aubio tempo`. If `region` is supplied, that slice
/// of the source is extracted to a temp WAV first so the estimate
/// reflects the loop the user is auditioning. Resolves to the
/// estimated BPM (positive float).
export async function detectBpm(
  src: string,
  region?: { start: number; end: number },
): Promise<number> {
  return invoke<number>("detect_bpm", {
    src,
    start: region?.start ?? null,
    end: region?.end ?? null,
  });
}

/// Prepend `duration` seconds of silence to the source. Writes
/// `{stem}-padstart.{ext}` next to the source.
export async function padStartAudio(
  src: string,
  duration: number,
): Promise<string> {
  return invoke<string>("pad_start_audio", { src, duration });
}

/// Append `duration` seconds of silence to the source. Writes
/// `{stem}-padend.{ext}` next to the source.
export async function padEndAudio(
  src: string,
  duration: number,
): Promise<string> {
  return invoke<string>("pad_end_audio", { src, duration });
}

/// Insert `duration` seconds of silence at `position` (seconds) in
/// the source — split + adelay + concat in a single ffmpeg pass.
/// Writes `{stem}-padmid.{ext}` next to the source.
export async function padAtAudio(
  src: string,
  position: number,
  duration: number,
): Promise<string> {
  return invoke<string>("pad_at_audio", { src, position, duration });
}

/// Match the source's length to `targetDuration` seconds — pad-end
/// if shorter, trim if longer. Writes `{stem}-match.{ext}` next to
/// the source. Errors if already matched within 1 ms.
/// Per-input parameters for renderMix. `region` is [start, end] in
/// seconds or null for the full file. Fade values in seconds; 0 = no
/// fade. `targetLenSec` is the non-destructive length-match target
/// applied via apad+atrim at bounce; null = no length match. Mirrors
/// the Rust `MixInput` struct.
export interface MixInput {
  src: string;
  region: [number, number] | null;
  fadeInSec: number;
  fadeOutSec: number;
  targetLenSec: number | null;
}

/// Bounce one or two tracks to a fresh WAV next to Track 1's source.
/// Each track's loop region and non-destructive fade envelope bakes
/// into the rendered file. Returns the absolute output path.
export async function renderMix(
  inputA: MixInput,
  inputB: MixInput | null,
): Promise<string> {
  return invoke<string>("render_mix", { inputA, inputB });
}

/// The clip tree's root — the roots-manifest entry that MIRRORS another (i.e.
/// the derived one: `music_clips mirrorOf music`). Read from the manifest, not
/// hardcoded, so "home" in the Library means whatever the suite's roots say.
/// null when there is no manifest or no mirror root.
export async function clipsRoot(): Promise<string | null> {
  return invoke<string | null>("clips_root");
}
