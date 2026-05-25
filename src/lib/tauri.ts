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

/// Fade the start of the source in from silence over `duration`
/// seconds. Writes `{stem}-fadein.{ext}` next to the source.
export async function fadeInAudio(
  src: string,
  duration: number,
): Promise<string> {
  return invoke<string>("fade_in_audio", { src, duration });
}

/// Fade the end of the source out to silence over `duration` seconds.
/// Writes `{stem}-fadeout.{ext}` next to the source.
export async function fadeOutAudio(
  src: string,
  duration: number,
): Promise<string> {
  return invoke<string>("fade_out_audio", { src, duration });
}
