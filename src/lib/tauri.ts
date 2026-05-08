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
