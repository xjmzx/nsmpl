import { invoke } from "@tauri-apps/api/core";

export interface AudioFile {
  path: string;
  name: string;
  size: number;
  modified: number; // unix seconds
}

export interface AudioInfo {
  sampleRate: number;
  channels: number;
  duration: number; // seconds
}

export async function listAudioFiles(dir: string): Promise<AudioFile[]> {
  return invoke<AudioFile[]>("list_audio_files", { dir });
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
