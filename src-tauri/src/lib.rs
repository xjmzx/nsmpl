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

/// Resolve the first non-colliding sibling for `{stem}-{tag}.{ext}` (or
/// `-{tag}-2`, `-{tag}-3`, …) so repeated edits of the same source don't
/// overwrite each other.
fn next_available_output_path(src: &Path, tag: &str) -> Result<PathBuf, String> {
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
    let base = dir.join(format!("{stem}-{tag}{suffix}"));
    if !base.exists() {
        return Ok(base);
    }
    for n in 2..10_000 {
        let p = dir.join(format!("{stem}-{tag}-{n}{suffix}"));
        if !p.exists() {
            return Ok(p);
        }
    }
    Err(format!("too many {tag} outputs in this folder"))
}

/// Run an ffmpeg invocation, surfacing the stderr tail on failure and a
/// friendly hint if the binary is missing.
fn run_ffmpeg(args: &[&str]) -> Result<(), String> {
    let output = Command::new("ffmpeg")
        .args(args)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "ffmpeg not found on PATH — install ffmpeg to enable edits".to_string()
            } else {
                format!("ffmpeg launch failed: {e}")
            }
        })?;
    if !output.status.success() {
        return Err(format!(
            "ffmpeg failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// Probe a source file's duration in seconds via ffprobe. Needed by
/// prune to decide whether the region touches a file boundary.
fn probe_duration(src: &str) -> Result<f64, String> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            src,
        ])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "ffprobe not found on PATH — install ffmpeg to enable edits".to_string()
            } else {
                format!("ffprobe launch failed: {e}")
            }
        })?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    s.parse::<f64>()
        .map_err(|e| format!("could not parse duration '{s}': {e}"))
}

/// Fade the start of the source file in from silence over `duration`
/// seconds via ffmpeg's `afade` filter. Re-encodes (filter can't
/// stream-copy a per-sample gain ramp). Output: `{stem}-fadein.{ext}`
/// next to source.
#[tauri::command]
fn fade_in_audio(src: String, duration: f64) -> Result<String, String> {
    if !duration.is_finite() || duration <= 0.0 {
        return Err(format!("invalid fade duration: {duration}"));
    }
    let src_path = Path::new(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let dst = next_available_output_path(src_path, "fadein")?;
    let dst_str = dst.to_string_lossy().into_owned();

    let res = run_ffmpeg(&[
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", &src,
        "-af", &format!("afade=t=in:ss=0:d={duration:.6}"),
        &dst_str,
    ]);
    if let Err(e) = res {
        let _ = fs::remove_file(&dst);
        return Err(e);
    }
    Ok(dst_str)
}

/// Fade the end of the source file out to silence over `duration`
/// seconds via ffmpeg's `afade` filter. Requires the file's duration
/// (ffprobe) to compute the fade start time. Re-encodes. Output:
/// `{stem}-fadeout.{ext}` next to source.
#[tauri::command]
fn fade_out_audio(src: String, duration: f64) -> Result<String, String> {
    if !duration.is_finite() || duration <= 0.0 {
        return Err(format!("invalid fade duration: {duration}"));
    }
    let src_path = Path::new(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let dur = probe_duration(&src)?;
    if duration >= dur {
        return Err(format!(
            "fade duration {duration:.3}s ≥ file duration {dur:.3}s"
        ));
    }
    let st = dur - duration;
    let dst = next_available_output_path(src_path, "fadeout")?;
    let dst_str = dst.to_string_lossy().into_owned();

    let res = run_ffmpeg(&[
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", &src,
        "-af", &format!("afade=t=out:st={st:.6}:d={duration:.6}"),
        &dst_str,
    ]);
    if let Err(e) = res {
        let _ = fs::remove_file(&dst);
        return Err(e);
    }
    Ok(dst_str)
}

/// Apply a linear-gain factor to the whole source file via ffmpeg's
/// `volume` filter. Requires a re-encode (codec can't stream-copy a
/// per-sample scale), so the output keeps the source's codec via
/// container-extension inference. Output is written next to the
/// source as `{stem}-gain.{ext}` (auto-suffixed on collision).
#[tauri::command]
fn gain_audio(src: String, gain: f64) -> Result<String, String> {
    if !gain.is_finite() || gain < 0.0 {
        return Err(format!("invalid gain factor: {gain}"));
    }
    let src_path = Path::new(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let dst = next_available_output_path(src_path, "gain")?;
    let dst_str = dst.to_string_lossy().into_owned();

    let res = run_ffmpeg(&[
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", &src,
        "-af", &format!("volume={gain:.6}"),
        &dst_str,
    ]);
    if let Err(e) = res {
        let _ = fs::remove_file(&dst);
        return Err(e);
    }
    Ok(dst_str)
}

/// Detect tempo (BPM) via `aubio tempo`. If `start` and `end` are
/// both provided, the region is extracted to a temp WAV first so the
/// estimate reflects what the user is looping; otherwise the source
/// is analysed whole. aubio prints beat timestamps; we compute
/// inter-beat intervals and return 60 / median.
#[tauri::command]
fn detect_bpm(
    src: String,
    start: Option<f64>,
    end: Option<f64>,
) -> Result<f64, String> {
    let src_path = Path::new(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }

    // Region present → extract to a temp WAV (PCM 16-bit, which aubio
    // handles reliably regardless of source codec).
    let region_temp: Option<PathBuf> = match (start, end) {
        (Some(s), Some(e)) => {
            if !s.is_finite() || !e.is_finite() || s < 0.0 || e <= s {
                return Err(format!("invalid region: start={s}, end={e}"));
            }
            let stamp = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let temp = std::env::temp_dir().join(format!("smpl-bpm-{stamp}.wav"));
            let temp_str = temp
                .to_str()
                .ok_or("temp path not utf-8")?
                .to_string();
            let res = run_ffmpeg(&[
                "-y", "-hide_banner", "-loglevel", "error",
                "-ss", &format!("{s:.6}"),
                "-to", &format!("{e:.6}"),
                "-i", &src,
                "-c:a", "pcm_s16le",
                &temp_str,
            ]);
            if let Err(e) = res {
                let _ = fs::remove_file(&temp);
                return Err(format!("region extract failed: {e}"));
            }
            Some(temp)
        }
        _ => None,
    };

    let analysis_path = match &region_temp {
        Some(p) => p.to_string_lossy().into_owned(),
        None => src.clone(),
    };

    let output = Command::new("aubio")
        .args(["tempo", &analysis_path])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "aubio not found on PATH — install aubio-tools".to_string()
            } else {
                format!("aubio launch failed: {e}")
            }
        });

    // Always clean up the temp region file, even on failure paths.
    if let Some(p) = region_temp {
        let _ = fs::remove_file(&p);
    }

    let output = output?;
    if !output.status.success() {
        return Err(format!(
            "aubio failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    // aubio tempo prints one beat timestamp per line. Take inter-beat
    // intervals, sort, return 60 / median.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let beats: Vec<f64> = stdout
        .lines()
        .filter_map(|l| l.trim().parse::<f64>().ok())
        .collect();
    if beats.len() < 2 {
        return Err(format!(
            "aubio found {} beats — too few to estimate BPM",
            beats.len()
        ));
    }
    let mut intervals: Vec<f64> = beats.windows(2).map(|w| w[1] - w[0]).collect();
    intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = intervals[intervals.len() / 2];
    if median <= 0.0 {
        return Err("median beat interval is zero".into());
    }
    Ok(60.0 / median)
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
    let dst = next_available_output_path(src_path, "trim")?;
    let dst_str = dst.to_string_lossy().into_owned();

    // -ss before -i = fast input seek (per-format-accurate, no full re-read).
    // -c copy keeps the original codec/quality.
    let res = run_ffmpeg(&[
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
    ]);
    if let Err(e) = res {
        // Best-effort cleanup if ffmpeg created a zero-byte file on failure.
        let _ = fs::remove_file(&dst);
        return Err(e);
    }
    Ok(dst_str)
}

/// Delete `[start, end]` from a source audio file, splicing the
/// remainder via ffmpeg's concat demuxer (stream-copy throughout). Same
/// quality contract as trim: sample-accurate on WAV/AIFF, frame-accurate
/// on FLAC, packet-boundary on lossy codecs (lossy splices may show
/// audible glitches at the join). Output is `{stem}-prune.{ext}` next
/// to the source (auto-suffixed on collision).
#[tauri::command]
fn prune_audio(src: String, start: f64, end: f64) -> Result<String, String> {
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start {
        return Err(format!("invalid prune range: start={start}, end={end}"));
    }
    let src_path = Path::new(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let dur = probe_duration(&src)?;
    if end > dur + 0.001 {
        return Err(format!(
            "region end {end:.3}s exceeds file duration {dur:.3}s"
        ));
    }
    let dst = next_available_output_path(src_path, "prune")?;
    let dst_str = dst.to_string_lossy().into_owned();

    // Treat sub-millisecond gaps to the file boundaries as the boundary
    // itself, so a region snapped to start/end falls back to a single
    // trim and skips the concat plumbing.
    let eps = 0.001;
    let has_a = start > eps;
    let has_b = (dur - end) > eps;

    if !has_a && !has_b {
        return Err("prune region covers the whole file — nothing left".into());
    }

    let res = if !has_a {
        // Region begins at file start — equivalent to keeping [end..dur].
        run_ffmpeg(&[
            "-y", "-hide_banner", "-loglevel", "error",
            "-ss", &format!("{end:.6}"),
            "-to", &format!("{dur:.6}"),
            "-i", &src,
            "-c", "copy",
            &dst_str,
        ])
    } else if !has_b {
        // Region ends at file end — equivalent to keeping [0..start].
        run_ffmpeg(&[
            "-y", "-hide_banner", "-loglevel", "error",
            "-to", &format!("{start:.6}"),
            "-i", &src,
            "-c", "copy",
            &dst_str,
        ])
    } else {
        prune_concat(&src, src_path, start, end, &dst_str)
    };

    if let Err(e) = res {
        let _ = fs::remove_file(&dst);
        return Err(e);
    }
    Ok(dst_str)
}

/// Two-segment splice: emit A=[0..start] and B=[end..eof] to temp files,
/// then concat them via the demuxer (all stream-copy). Temps are
/// cleaned up on every exit path.
fn prune_concat(
    src: &str,
    src_path: &Path,
    start: f64,
    end: f64,
    dst: &str,
) -> Result<(), String> {
    let ext = src_path.extension().and_then(|s| s.to_str()).unwrap_or("");
    let ext_suffix = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    let temp_dir = std::env::temp_dir();
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seg_a = temp_dir.join(format!("smpl-prune-{stamp}-a{ext_suffix}"));
    let seg_b = temp_dir.join(format!("smpl-prune-{stamp}-b{ext_suffix}"));
    let list = temp_dir.join(format!("smpl-prune-{stamp}.txt"));

    let result = (|| -> Result<(), String> {
        let seg_a_str = seg_a.to_str().ok_or("temp path not utf-8")?;
        let seg_b_str = seg_b.to_str().ok_or("temp path not utf-8")?;
        let list_str = list.to_str().ok_or("list path not utf-8")?;

        run_ffmpeg(&[
            "-y", "-hide_banner", "-loglevel", "error",
            "-to", &format!("{start:.6}"),
            "-i", src,
            "-c", "copy",
            seg_a_str,
        ])?;
        run_ffmpeg(&[
            "-y", "-hide_banner", "-loglevel", "error",
            "-ss", &format!("{end:.6}"),
            "-i", src,
            "-c", "copy",
            seg_b_str,
        ])?;
        let list_body = format!(
            "file '{}'\nfile '{}'\n",
            escape_concat_path(&seg_a.to_string_lossy()),
            escape_concat_path(&seg_b.to_string_lossy()),
        );
        fs::write(&list, &list_body).map_err(|e| format!("write concat list: {e}"))?;
        run_ffmpeg(&[
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "concat",
            "-safe", "0",
            "-i", list_str,
            "-c", "copy",
            dst,
        ])
    })();

    let _ = fs::remove_file(&seg_a);
    let _ = fs::remove_file(&seg_b);
    let _ = fs::remove_file(&list);
    result
}

/// Escape a path for ffmpeg's concat demuxer (single-quoted entries):
/// `\` → `\\` and `'` → `'\''`. Other chars pass through unchanged.
fn escape_concat_path(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "'\\''")
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
            prune_audio,
            gain_audio,
            fade_in_audio,
            fade_out_audio,
            detect_bpm,
            get_identity,
            generate_identity,
            import_identity,
            clear_identity
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
