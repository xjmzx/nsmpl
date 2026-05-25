// Tauri commands for smpl-tool. See https://tauri.app/develop/calling-rust/

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

use keyring::Entry;
use nostr::nips::nip19::{FromBech32, ToBech32};
use nostr::{Keys, SecretKey};
use serde::Serialize;
use tauri::ipc::Response;

const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "flac", "mp3", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "wv",
];

const KEYRING_SERVICE_RELEASE: &str = "smpl-tool";
const KEYRING_SERVICE_DEV: &str = "smpl-tool-dev";
const KEYRING_USER: &str = "default";

/// Debug builds (`tauri dev`) use a separate keychain service so dev
/// state never reads or writes the real installed-app nsec. Matches
/// ndisc / audio-flac-quality-check-tauri.
fn keyring_service() -> &'static str {
    if cfg!(debug_assertions) {
        KEYRING_SERVICE_DEV
    } else {
        KEYRING_SERVICE_RELEASE
    }
}

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

/// Resolve the first non-colliding sibling for `{stem}-trim.{ext}` (or
/// `-trim-2`, `-trim-3`, …) so repeated trims of the same source don't
/// overwrite each other.
fn next_available_trim_path(src: &Path) -> Result<PathBuf, String> {
    let dir = src.parent().ok_or("source has no parent directory")?;
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("source filename is not valid UTF-8")?;
    let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("");
    let suffix = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    let base = dir.join(format!("{stem}-trim{suffix}"));
    if !base.exists() {
        return Ok(base);
    }
    for n in 2..10_000 {
        let p = dir.join(format!("{stem}-trim-{n}{suffix}"));
        if !p.exists() {
            return Ok(p);
        }
    }
    Err("too many trim outputs in this folder".into())
}

/// Trim a source audio file to `[start, end]` seconds via ffmpeg
/// stream-copy. Sample-accurate on WAV/AIFF; frame-boundary accurate on
/// FLAC; packet-boundary (~20ms) on lossy codecs. Output is written
/// next to the source as `{stem}-trim.{ext}` (auto-suffixed on
/// collision). Returns the absolute output path.
#[tauri::command]
fn trim_audio(src: String, start: f64, end: f64) -> Result<String, String> {
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start {
        return Err(format!("invalid trim range: start={start}, end={end}"));
    }
    let src_path = Path::new(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let dst = next_available_trim_path(src_path)?;
    let dst_str = dst.to_string_lossy().into_owned();

    // -ss before -i = fast input seek (per-format-accurate, no full re-read).
    // -c copy keeps the original codec/quality.
    let output = Command::new("ffmpeg")
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            &format!("{start:.6}"),
            "-to",
            &format!("{end:.6}"),
            "-i",
            &src,
            "-c",
            "copy",
            &dst_str,
        ])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "ffmpeg not found on PATH — install ffmpeg to enable trim".to_string()
            } else {
                format!("ffmpeg launch failed: {e}")
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Best-effort cleanup if ffmpeg created a zero-byte file on failure.
        let _ = fs::remove_file(&dst);
        return Err(format!("ffmpeg failed: {}", stderr.trim()));
    }

    Ok(dst_str)
}

// ---- nostr identity (OS keychain) -------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    npub: String,
    pk: String,      // hex pubkey
    /// Hex-encoded 32-byte secret key. smpl-tool's publish flow signs
    /// in JS (nostr-tools `finalizeEvent`) so the sk has to leave the
    /// keychain into the renderer. Trade-off: keychain protects the
    /// at-rest secret; per-session JS memory is the unavoidable
    /// exposure of any in-app signing flow.
    sk: String,
    nsec: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedIdentity {
    npub: String,
    pk: String,
    sk: String,
    nsec: String,
}

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(keyring_service(), KEYRING_USER).map_err(|e| e.to_string())
}

fn load_nsec() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn store_nsec(nsec: &str) -> Result<(), String> {
    keyring_entry()?
        .set_password(nsec)
        .map_err(|e| e.to_string())
}

fn keys_from_nsec(nsec: &str) -> Result<Keys, String> {
    let sk = SecretKey::from_bech32(nsec).map_err(|e| format!("invalid nsec: {e}"))?;
    Ok(Keys::new(sk))
}

fn identity_from_keys(keys: &Keys, nsec: String) -> Result<Identity, String> {
    let npub = keys.public_key().to_bech32().map_err(|e| e.to_string())?;
    let pk = keys.public_key().to_hex();
    let sk = keys.secret_key().display_secret().to_string();
    Ok(Identity { npub, pk, sk, nsec })
}

#[tauri::command]
fn get_identity() -> Result<Option<Identity>, String> {
    let Some(nsec) = load_nsec()? else {
        return Ok(None);
    };
    let keys = keys_from_nsec(&nsec)?;
    Ok(Some(identity_from_keys(&keys, nsec)?))
}

#[tauri::command]
fn generate_identity() -> Result<GeneratedIdentity, String> {
    let keys = Keys::generate();
    let nsec = keys
        .secret_key()
        .to_bech32()
        .map_err(|e| e.to_string())?;
    store_nsec(&nsec)?;
    let id = identity_from_keys(&keys, nsec.clone())?;
    Ok(GeneratedIdentity {
        npub: id.npub,
        pk: id.pk,
        sk: id.sk,
        nsec,
    })
}

#[tauri::command]
fn import_identity(nsec: String) -> Result<Identity, String> {
    let nsec = nsec.trim().to_owned();
    let keys = keys_from_nsec(&nsec)?;
    store_nsec(&nsec)?;
    identity_from_keys(&keys, nsec)
}

#[tauri::command]
fn clear_identity() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_audio_files,
            read_audio_file,
            trim_audio,
            get_identity,
            generate_identity,
            import_identity,
            clear_identity
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
