// Tauri commands for smpl-tool. See https://tauri.app/develop/calling-rust/

use std::fs;
use std::path::Path;
use std::time::SystemTime;

use serde::Serialize;
use tauri::ipc::Response;

const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "flac", "mp3", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "wv",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioFile {
    path: String,
    name: String,
    size: u64,
    /// seconds since UNIX epoch (0 if unavailable).
    modified: u64,
}

fn is_audio_ext(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            AUDIO_EXTENSIONS.iter().any(|&x| x == lower)
        })
        .unwrap_or(false)
}

#[tauri::command]
fn list_audio_files(dir: String) -> Result<Vec<AudioFile>, String> {
    let path = Path::new(&dir);
    if !path.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    let mut out: Vec<AudioFile> = entries
        .filter_map(|res| res.ok())
        .filter_map(|entry| {
            let p = entry.path();
            if !p.is_file() || !is_audio_ext(&p) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            Some(AudioFile {
                path: p.to_string_lossy().into_owned(),
                name: entry.file_name().to_string_lossy().into_owned(),
                size: meta.len(),
                modified,
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Read a file as raw bytes. Returns a `Response` so Tauri IPC ships it
/// as an `ArrayBuffer` rather than a JSON array of numbers — fast for
/// audio buffers up to tens of MB.
#[tauri::command]
async fn read_audio_file(path: String) -> Result<Response, String> {
    let data = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(Response::new(data))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![list_audio_files, read_audio_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
