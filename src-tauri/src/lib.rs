// Tauri commands for smpl-tool. See https://tauri.app/develop/calling-rust/

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

use keyring::Entry;
use nostr::nips::nip19::{FromBech32, ToBech32};
use nostr::{Keys, SecretKey};
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;

const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "flac", "mp3", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "wv",
];

// Video (audio-visual) extensions — the same set ndisc recognises, so the
// suite shares one definition of "carries video". smpl surfaces them as part
// of the full media spectrum; it does not analyse or play them (yet).
const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "mov", "webm", "m4v", "avi", "wmv", "flv", "mpg", "mpeg", "ogv",
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
    /// Path relative to the listed root. For a flat listing this is just the
    /// filename; for a deep listing it's `artist/release/…/file`, which the
    /// frontend splits into artist / release columns (blobtree-style).
    rel: String,
    /// True when this is a video (audio-visual) file rather than audio. Lets
    /// the browser mark it; smpl doesn't sample/play video.
    is_video: bool,
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

fn is_video_ext(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            VIDEO_EXTENSIONS.iter().any(|&x| x == lower)
        })
        .unwrap_or(false)
}

/// Either audio or video — the files the browser lists across the full media
/// spectrum.
fn is_media_ext(p: &Path) -> bool {
    is_audio_ext(p) || is_video_ext(p)
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
            if !p.is_file() || !is_media_ext(&p) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let name = entry.file_name().to_string_lossy().into_owned();
            Some(AudioFile {
                path: p.to_string_lossy().into_owned(),
                rel: name.clone(),
                name,
                size: meta.len(),
                modified,
                is_video: is_video_ext(&p),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Cap on a deep listing so a misconfigured root (e.g. `/`) can't hang the UI.
const DEEP_LIST_CAP: usize = 20_000;

fn collect_audio_deep(dir: &Path, base: &Path, out: &mut Vec<AudioFile>) {
    if out.len() >= DEEP_LIST_CAP {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if out.len() >= DEEP_LIST_CAP {
            return;
        }
        let p = entry.path();
        if p.is_dir() {
            collect_audio_deep(&p, base, out);
        } else if p.is_file() && is_media_ext(&p) {
            let Ok(meta) = entry.metadata() else { continue };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let rel = p
                .strip_prefix(base)
                .map(|r| r.to_string_lossy().into_owned())
                .unwrap_or_else(|_| entry.file_name().to_string_lossy().into_owned());
            out.push(AudioFile {
                path: p.to_string_lossy().into_owned(),
                name: entry.file_name().to_string_lossy().into_owned(),
                size: meta.len(),
                modified,
                rel,
                is_video: is_video_ext(&p),
            });
        }
    }
}

/// Recursively list audio files under `dir`, each carrying its `rel` path so
/// the UI can browse a whole tree (e.g. /data/music_clips at the artist
/// level), blobtree-style. Capped at DEEP_LIST_CAP.
#[tauri::command]
fn list_audio_files_deep(dir: String) -> Result<Vec<AudioFile>, String> {
    let base = Path::new(&dir);
    if !base.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let mut out = Vec::new();
    collect_audio_deep(base, base, &mut out);
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderEntry {
    /// Path relative to the listed root, e.g. "Artist/Release".
    rel: String,
    /// Absolute path (so a click can drill straight in via list_audio_files).
    path: String,
    /// Count of audio files directly inside this leaf folder (0 ⇒ a gap —
    /// a release folder where no clips landed).
    audio_count: usize,
    /// Count of video files directly inside this leaf folder — lets the UI
    /// mark releases that carry audio-visual content.
    video_count: usize,
    /// Number of discs. 1 for a normal leaf; >1 when this row is a multi-disc
    /// release collapsed from its CD1/CD2/… subfolders (see collect_leaf_folders).
    disc_count: usize,
}

/// Is this a disc subfolder name — "CD1", "CD 2", "Disc 3", "Disk1", …? Used to
/// recognise (and collapse) multi-disc release layouts.
fn is_disc_dir_name(name: &str) -> bool {
    let n = name.trim().to_ascii_lowercase();
    for prefix in ["cd", "disc", "disk"] {
        if let Some(rest) = n.strip_prefix(prefix) {
            let rest = rest.trim_start_matches([' ', '-', '_', '.']);
            if matches!(rest.chars().next(), Some(c) if c.is_ascii_digit()) {
                return true;
            }
        }
    }
    false
}

/// Walk to the *leaf* folders under `dir` (those with no child directories —
/// i.e. where files actually live) and report each with its direct audio
/// count. Empty / no-audio leaves are included so the UI can flag sampling
/// gaps. Multi-disc layouts surface their CD subfolders as the leaves.
fn collect_leaf_folders(dir: &Path, base: &Path, out: &mut Vec<FolderEntry>) {
    if out.len() >= DEEP_LIST_CAP {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    let entries: Vec<_> = rd.flatten().collect();
    let mut subdirs: Vec<PathBuf> =
        entries.iter().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    if subdirs.is_empty() {
        // Leaf folder — skip the base itself (only report sub-folders).
        let Ok(rel) = dir.strip_prefix(base) else { return };
        if rel.as_os_str().is_empty() {
            return;
        }
        let audio_count = entries
            .iter()
            .filter(|e| {
                let p = e.path();
                p.is_file() && is_audio_ext(&p)
            })
            .count();
        let video_count = entries
            .iter()
            .filter(|e| {
                let p = e.path();
                p.is_file() && is_video_ext(&p)
            })
            .count();
        out.push(FolderEntry {
            rel: rel.to_string_lossy().into_owned(),
            path: dir.to_string_lossy().into_owned(),
            audio_count,
            video_count,
            disc_count: 1,
        });
    } else {
        subdirs.sort();
        // Multi-disc release: when EVERY subdir is a "CD1 / Disc 2 / …" folder,
        // collapse them into one release row carrying the disc count + summed
        // audio, so the listing matches ndisc (track dots + a disc-count circle)
        // instead of a row per disc. Only collapses in the PARENT listing — the
        // non-empty-rel guard means drilling INTO the release still lists its
        // individual discs, so per-disc sampling is preserved.
        let all_discs = subdirs.iter().all(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(is_disc_dir_name)
                .unwrap_or(false)
        });
        if all_discs {
            if let Ok(rel) = dir.strip_prefix(base) {
                if !rel.as_os_str().is_empty() {
                    let (mut audio_count, mut video_count) = (0usize, 0usize);
                    for sub in &subdirs {
                        if let Ok(rd) = fs::read_dir(sub) {
                            for e in rd.flatten() {
                                let p = e.path();
                                if p.is_file() {
                                    if is_audio_ext(&p) {
                                        audio_count += 1;
                                    } else if is_video_ext(&p) {
                                        video_count += 1;
                                    }
                                }
                            }
                        }
                    }
                    out.push(FolderEntry {
                        rel: rel.to_string_lossy().into_owned(),
                        path: dir.to_string_lossy().into_owned(),
                        audio_count,
                        video_count,
                        disc_count: subdirs.len(),
                    });
                    return;
                }
            }
        }
        for s in subdirs {
            collect_leaf_folders(&s, base, out);
        }
    }
}

/// List the leaf folders under `dir` with their audio counts — the folder-grain
/// "has audio / no audio" view used when a parent dir (e.g. /data/music_clips)
/// holds no direct audio of its own.
#[tauri::command]
fn list_leaf_folders(dir: String) -> Result<Vec<FolderEntry>, String> {
    let base = Path::new(&dir);
    if !base.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let mut out = Vec::new();
    collect_leaf_folders(base, base, &mut out);
    out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    Ok(out)
}

/// Does a path exist on disk? Used by the publisher to offer the Opus web copy
/// of a FLAC clip only when it has actually been compressed.
#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
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

/// Like `next_available_output_path` but forces a `.wav` extension on
/// the output regardless of the source's container. Used by `render_mix`
/// where the bounced product is a fresh sampler-grade WAV asset, not a
/// codec-preserving derivative of either input.
fn next_available_wav_output_path(src: &Path, tag: &str) -> Result<PathBuf, String> {
    let dir = src.parent().ok_or("source has no parent directory")?;
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("source filename is not valid UTF-8")?;
    let base = dir.join(format!("{stem}-{tag}.wav"));
    if !base.exists() {
        return Ok(base);
    }
    for n in 2..10_000 {
        let p = dir.join(format!("{stem}-{tag}-{n}.wav"));
        if !p.exists() {
            return Ok(p);
        }
    }
    Err(format!("too many {tag} outputs in this folder"))
}

/// Per-input parameters for `render_mix`. Bundled so the frontend
/// can grow the surface (extra envelope shapes, per-track gain, etc.)
/// without churning the tauri::command argument list each time.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MixInput {
    src: String,
    /// Loop region [start, end] in seconds. None = the whole file.
    region: Option<(f64, f64)>,
    /// Linear fade-in length in seconds. 0 = no fade.
    fade_in_sec: f64,
    /// Linear fade-out length in seconds. 0 = no fade.
    fade_out_sec: f64,
    /// Length-match target in seconds. When Some(t > 0), the chain
    /// pads (apad) or trims (atrim) the input to exactly `t` seconds
    /// before any fade filters apply. None = no length match.
    target_len_sec: Option<f64>,
}

/// Build a per-input processing chain. Order: length-match first
/// (apad+atrim so output is exactly target_len whether input was
/// shorter or longer), then fades. Empty body returns an anull pass
/// so the caller can drop in a uniform `[a{idx}]` label.
///
/// `audible_len` is the input's length as the filter sees it (the
/// region length when -ss/-to trims at input, else the full file
/// duration). When `target_len` is Some, fades use that as their
/// reference for fade-out start; otherwise they use audible_len.
fn input_processing_chain(
    idx: usize,
    audible_len: f64,
    fade_in: f64,
    fade_out: f64,
    target_len: Option<f64>,
) -> String {
    let mut parts: Vec<String> = vec![];
    let effective_len = match target_len {
        Some(t) if t > 0.0 => {
            // apad with whole_dur passes through unchanged if the
            // input already meets target; atrim caps any overshoot.
            // With both in this order the output is exactly target
            // length regardless of input length.
            parts.push(format!("apad=whole_dur={t:.6}"));
            parts.push(format!("atrim=duration={t:.6}"));
            t
        }
        _ => audible_len,
    };
    if fade_in > 0.0 {
        parts.push(format!("afade=t=in:st=0:d={fade_in:.6}"));
    }
    if fade_out > 0.0 {
        let st = (effective_len - fade_out).max(0.0);
        parts.push(format!("afade=t=out:st={st:.6}:d={fade_out:.6}"));
    }
    let body = parts.join(",");
    if body.is_empty() {
        format!("[{idx}:a]anull[a{idx}]")
    } else {
        format!("[{idx}:a]{body}[a{idx}]")
    }
}

/// Bounce a mix of one or two source files to a fresh WAV next to
/// Track 1's source. Each input gets its own region trim (input-level
/// `-ss/-to`) and optional fade-in/fade-out envelope (`afade` filter).
/// Two-input case mixes via ffmpeg `amix=normalize=0` so unity-summed
/// sources don't get the default 1/N attenuation. Output:
/// `{src_a stem}-mix.wav` (auto-suffixed on collision), 16-bit PCM.
/// When no fades are set, takes a simpler filter-free path that
/// avoids the filter_complex graph entirely.
#[tauri::command]
fn render_mix(input_a: MixInput, input_b: Option<MixInput>) -> Result<String, String> {
    let src_a_path = Path::new(&input_a.src);
    if !src_a_path.is_file() {
        return Err(format!("not a file: {}", input_a.src));
    }

    let dst = next_available_wav_output_path(src_a_path, "mix")?;
    let dst_str = dst.to_string_lossy().into_owned();

    // Pre-format region time strings up front — run_ffmpeg takes
    // &[&str], so the backing Strings must outlive the slice we build.
    fn region_ss_to(region: Option<(f64, f64)>) -> Option<(String, String)> {
        match region {
            Some((s, e))
                if s.is_finite() && e.is_finite() && s >= 0.0 && e > s =>
            {
                Some((format!("{s:.6}"), format!("{e:.6}")))
            }
            _ => None,
        }
    }

    // Audible length each input contributes (used by fade-out st).
    fn input_len(input: &MixInput) -> Result<f64, String> {
        if let Some((s, e)) = input.region {
            if e > s {
                return Ok(e - s);
            }
        }
        probe_duration(&input.src)
    }

    let a_seek = region_ss_to(input_a.region);
    let any_processing_a = input_a.fade_in_sec > 0.0
        || input_a.fade_out_sec > 0.0
        || input_a.target_len_sec.is_some();

    let res = if let Some(input_b) = input_b.as_ref() {
        let src_b_path = Path::new(&input_b.src);
        if !src_b_path.is_file() {
            return Err(format!("not a file: {}", input_b.src));
        }
        let b_seek = region_ss_to(input_b.region);
        let any_processing_b = input_b.fade_in_sec > 0.0
            || input_b.fade_out_sec > 0.0
            || input_b.target_len_sec.is_some();

        // Build the filter graph: per-input processing chains feeding
        // amix. Even when both chains pass through (no envelope or
        // length-match), we still go through filter_complex so amix
        // is reachable.
        let chain_a = if any_processing_a {
            let len = input_len(&input_a)?;
            input_processing_chain(
                0, len,
                input_a.fade_in_sec, input_a.fade_out_sec,
                input_a.target_len_sec,
            )
        } else {
            "[0:a]anull[a0]".to_string()
        };
        let chain_b = if any_processing_b {
            let len = input_len(input_b)?;
            input_processing_chain(
                1, len,
                input_b.fade_in_sec, input_b.fade_out_sec,
                input_b.target_len_sec,
            )
        } else {
            "[1:a]anull[a1]".to_string()
        };
        let graph = format!(
            "{chain_a};{chain_b};[a0][a1]amix=inputs=2:duration=longest:normalize=0[mix]"
        );

        let mut args: Vec<&str> = vec!["-y", "-hide_banner", "-loglevel", "error"];
        if let Some((s, e)) = a_seek.as_ref() {
            args.push("-ss"); args.push(s);
            args.push("-to"); args.push(e);
        }
        args.push("-i"); args.push(&input_a.src);
        if let Some((s, e)) = b_seek.as_ref() {
            args.push("-ss"); args.push(s);
            args.push("-to"); args.push(e);
        }
        args.push("-i"); args.push(&input_b.src);
        args.push("-filter_complex"); args.push(&graph);
        args.push("-map"); args.push("[mix]");
        args.push("-c:a"); args.push("pcm_s16le");
        args.push(&dst_str);
        run_ffmpeg(&args)
    } else if any_processing_a {
        // Single track with envelope or length-match — filter_complex
        // with the chain mapping out [a0].
        let len = input_len(&input_a)?;
        let graph = input_processing_chain(
            0, len,
            input_a.fade_in_sec, input_a.fade_out_sec,
            input_a.target_len_sec,
        );

        let mut args: Vec<&str> = vec!["-y", "-hide_banner", "-loglevel", "error"];
        if let Some((s, e)) = a_seek.as_ref() {
            args.push("-ss"); args.push(s);
            args.push("-to"); args.push(e);
        }
        args.push("-i"); args.push(&input_a.src);
        args.push("-filter_complex"); args.push(&graph);
        args.push("-map"); args.push("[a0]");
        args.push("-c:a"); args.push("pcm_s16le");
        args.push(&dst_str);
        run_ffmpeg(&args)
    } else {
        // Single track, no fade — plain re-encode to WAV with the
        // region trim applied at input level. Avoids the filter graph
        // entirely for the cheapest fast path.
        let mut args: Vec<&str> = vec!["-y", "-hide_banner", "-loglevel", "error"];
        if let Some((s, e)) = a_seek.as_ref() {
            args.push("-ss"); args.push(s);
            args.push("-to"); args.push(e);
        }
        args.push("-i"); args.push(&input_a.src);
        args.push("-c:a"); args.push("pcm_s16le");
        args.push(&dst_str);
        run_ffmpeg(&args)
    };

    if let Err(e) = res {
        let _ = fs::remove_file(&dst);
        return Err(e);
    }
    Ok(dst_str)
}

/// Prepend `duration` seconds of silence to the source via ffmpeg's
/// `adelay` filter. `all=1` applies the same delay to every channel
/// regardless of source layout. Output: `{stem}-padstart.{ext}`.
#[tauri::command]
fn pad_start_audio(src: String, duration: f64) -> Result<String, String> {
    if !duration.is_finite() || duration <= 0.0 {
        return Err(format!("invalid pad duration: {duration}"));
    }
    let src_path = Path::new(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let dst = next_available_output_path(src_path, "padstart")?;
    let dst_str = dst.to_string_lossy().into_owned();
    let ms = (duration * 1000.0).round() as i64;
    let res = run_ffmpeg(&[
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", &src,
        "-af", &format!("adelay={ms}:all=1"),
        &dst_str,
    ]);
    if let Err(e) = res {
        let _ = fs::remove_file(&dst);
        return Err(e);
    }
    Ok(dst_str)
}

/// Append `duration` seconds of silence to the source via ffmpeg's
/// `apad` filter (whole_dur covers all channels automatically).
/// Output: `{stem}-padend.{ext}`.
#[tauri::command]
fn pad_end_audio(src: String, duration: f64) -> Result<String, String> {
    if !duration.is_finite() || duration <= 0.0 {
        return Err(format!("invalid pad duration: {duration}"));
    }
    let src_path = Path::new(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let dst = next_available_output_path(src_path, "padend")?;
    let dst_str = dst.to_string_lossy().into_owned();
    let res = run_ffmpeg(&[
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", &src,
        "-af", &format!("apad=pad_dur={duration:.6}"),
        &dst_str,
    ]);
    if let Err(e) = res {
        let _ = fs::remove_file(&dst);
        return Err(e);
    }
    Ok(dst_str)
}

/// Insert `duration` seconds of silence at `position` in the source —
/// split at position, adelay the second half by `duration`, concat
/// the two via filter_complex in a single ffmpeg call. Output:
/// `{stem}-padmid.{ext}`.
#[tauri::command]
fn pad_at_audio(
    src: String,
    position: f64,
    duration: f64,
) -> Result<String, String> {
    if !duration.is_finite() || duration <= 0.0 {
        return Err(format!("invalid pad duration: {duration}"));
    }
    if !position.is_finite() || position < 0.0 {
        return Err(format!("invalid pad position: {position}"));
    }
    let src_path = Path::new(&src);
    if !src_path.is_file() {
        return Err(format!("not a file: {src}"));
    }
    let dst = next_available_output_path(src_path, "padmid")?;
    let dst_str = dst.to_string_lossy().into_owned();
    let ms = (duration * 1000.0).round() as i64;
    let filter = format!(
        "[0:a]atrim=0:{position:.6},asetpts=PTS-STARTPTS[a];\
         [0:a]atrim={position:.6},asetpts=PTS-STARTPTS,adelay={ms}:all=1[b];\
         [a][b]concat=n=2:v=0:a=1[out]"
    );
    let res = run_ffmpeg(&[
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", &src,
        "-filter_complex", &filter,
        "-map", "[out]",
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

// ---------------------------------------------------------------------------
// Terrain roots — read the shared suite manifest and resolve a clip back to
// its source track. Phase 1: filesystem-only (no ndisc, no relays).
//
// Manifest lives at ~/.config/ndisc-suite/roots.json — per-machine, local,
// NEVER published (paths differ per machine). See ndisc's
// schema/terrain-roots-design note for the model. Borrows the label-art
// manifest's declarative, tolerant-consumer shape: a missing or malformed
// manifest simply yields "no resolution", never an error.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RootEntry {
    #[serde(default)]
    paths: Vec<String>,
    /// When set, files under this root mirror artifacts under the named root
    /// (e.g. music_clips mirrorOf music) — used to resolve a clip's source.
    #[serde(rename = "mirrorOf", default)]
    mirror_of: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RootsManifest {
    #[serde(default)]
    roots: std::collections::HashMap<String, RootEntry>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SourceResolution {
    /// The named root the file lives under (manifest key), if matched.
    root: Option<String>,
    /// Path relative to that root.
    rel: Option<String>,
    /// For a clip under a `mirrorOf` root: the resolved source track path.
    source_path: Option<String>,
    /// Whether that source track actually exists on disk (false ⇒ drift).
    source_exists: bool,
}


/// The suite's shared directory — deliberately OUTSIDE each app's private data
/// dir, because the whole point is that the other suite apps can read it. Every
/// app must resolve this identically. Linux unchanged (installs depend on it);
/// macOS shares it (nothing there uses it yet, so nothing to migrate). Windows
/// uses LOCALAPPDATA not APPDATA on purpose: everything here is MACHINE-specific
/// (roots.json points at local library paths), so it must not roam.
fn suite_shared_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|b| PathBuf::from(b).join("ndisc-suite"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share/ndisc-suite"))
    }
}

/// Config counterpart of `suite_shared_dir`. On unix the XDG split puts
/// roots.json under ~/.config; Windows has no such split, so both collapse to
/// the same per-machine directory.
fn suite_config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|b| PathBuf::from(b).join("ndisc-suite"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config/ndisc-suite"))
    }
}

fn load_roots_manifest() -> Option<RootsManifest> {
    let p = suite_config_dir()?.join("roots.json");
    let raw = fs::read_to_string(p).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Segment-safe relative path of `full` under `root` (None if not under it).
fn rel_under(root: &str, full: &str) -> Option<String> {
    let r = root.trim_end_matches('/');
    if full == r {
        return Some(String::new());
    }
    full.strip_prefix(&format!("{r}/")).map(str::to_string)
}

/// Strip a clip duration suffix `.<digits>s.<ext>` from the final path
/// component, returning the relpath ending in the bare source stem. None when
/// the filename isn't a clip (so non-clip files don't pretend to have a source).
fn strip_clip_suffix(rel: &str) -> Option<String> {
    let (dir, file) = match rel.rsplit_once('/') {
        Some((d, f)) => (Some(d), f),
        None => (None, rel),
    };
    let (before_ext, _ext) = file.rsplit_once('.')?; // "01 }.10s" , "flac"
    let (stem, durs) = before_ext.rsplit_once('.')?; // "01 }" , "10s"
    let is_dur = durs.len() > 1
        && durs.ends_with('s')
        && durs[..durs.len() - 1].chars().all(|c| c.is_ascii_digit());
    if !is_dur {
        return None;
    }
    Some(match dir {
        Some(d) => format!("{d}/{stem}"),
        None => stem.to_string(),
    })
}

/// In the directory implied by `<root>/<dir(stem_rel)>`, find an audio file
/// whose stem equals `basename(stem_rel)` (source extension may differ from
/// the clip's). Returns its absolute path.
fn find_by_stem(root: &str, stem_rel: &str) -> Option<String> {
    let full = format!("{}/{stem_rel}", root.trim_end_matches('/'));
    let p = Path::new(&full);
    let dir = p.parent()?;
    let want = p.file_name()?.to_str()?;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let ep = entry.path();
        if ep.is_file()
            && is_audio_ext(&ep)
            && ep.file_stem().and_then(|s| s.to_str()) == Some(want)
        {
            return Some(ep.to_string_lossy().into_owned());
        }
    }
    None
}

#[tauri::command]
fn resolve_source(path: String) -> SourceResolution {
    let mut out = SourceResolution::default();
    let Some(manifest) = load_roots_manifest() else {
        return out;
    };

    // Longest matching root path wins (segment-safe), so nested roots resolve
    // to the deepest one.
    let mut best: Option<(&String, &RootEntry, usize, String)> = None;
    for (name, entry) in &manifest.roots {
        for rp in &entry.paths {
            if let Some(rel) = rel_under(rp, &path) {
                let len = rp.trim_end_matches('/').len();
                if best.as_ref().map_or(true, |(_, _, blen, _)| len > *blen) {
                    best = Some((name, entry, len, rel));
                }
            }
        }
    }
    let Some((name, entry, _, rel)) = best else {
        return out;
    };
    out.root = Some(name.clone());
    out.rel = Some(rel.clone());

    // If this root mirrors another, resolve the clip back to its source track.
    if let Some(mirror_name) = &entry.mirror_of {
        if let (Some(mirror), Some(stem_rel)) =
            (manifest.roots.get(mirror_name), strip_clip_suffix(&rel))
        {
            for mp in &mirror.paths {
                if let Some(found) = find_by_stem(mp, &stem_rel) {
                    out.source_path = Some(found);
                    out.source_exists = true;
                    break;
                }
            }
            // Surface the expected path even when missing, so the UI can flag
            // drift (renamed/removed source) rather than show nothing.
            if out.source_path.is_none() {
                if let Some(mp) = mirror.paths.first() {
                    out.source_path =
                        Some(format!("{}/{stem_rel}", mp.trim_end_matches('/')));
                }
            }
        }
    }
    out
}

/// Per-clip duration coverage for a browsed folder: the clip's own probed
/// length and its resolved source track's length. `ffprobe format=duration` is
/// a header read (no decode), so this runs live on folder-open — no scan, which
/// is why nsmpl can match ntree's coverage bar without ntree's rescan. Both
/// fields are optional: a clip we can't probe, or whose source doesn't resolve
/// (drift / not under a mirror root), simply renders no bar.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipCoverage {
    path: String,
    clip_secs: Option<f64>,
    source_secs: Option<f64>,
}

#[tauri::command]
fn folder_coverage(dir: String) -> Result<Vec<ClipCoverage>, String> {
    let files = list_audio_files(dir)?;
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        if f.is_video {
            out.push(ClipCoverage {
                path: f.path,
                clip_secs: None,
                source_secs: None,
            });
            continue;
        }
        let clip_secs = probe_duration(&f.path).ok();
        let res = resolve_source(f.path.clone());
        let source_secs = match (res.source_exists, res.source_path) {
            (true, Some(sp)) => probe_duration(&sp).ok(),
            _ => None,
        };
        out.push(ClipCoverage {
            path: f.path,
            clip_secs,
            source_secs,
        });
    }
    Ok(out)
}

// ---- ndisc published-release manifest (read-only) --------------------------
//
// `~/.local/share/ndisc-suite/published.json`, exported by ndisc. nsmpl is
// deliberately **read-only** with respect to it — and read-only about Nostr
// publishing generally: it edits audio, it does not own publish state. Knowing
// which releases ndisc has published is enough to scope the Library to the
// published discography; recording what *this* app published is a different
// problem (a lifecycle, not a boolean) and belongs where publish state already
// lives.
//
// Returned as relpaths under the library root, because that is the shape the
// clip tree mirrors: a clip folder `214/Fuel Cells` under `music_clips`
// corresponds to the release `214/Fuel Cells` under `music`. Absolute paths
// would force the frontend to know both roots.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestRelease {
    dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishedManifest {
    #[serde(default)]
    releases: Vec<ManifestRelease>,
}

/// The clip tree's root — the roots-manifest entry that MIRRORS another (i.e.
/// the derived one: `music_clips mirrorOf music`). Read from the manifest
/// rather than hardcoded, so "home" in the Library means whatever the suite's
/// roots say it means. `Ok(None)` when there is no manifest or no mirror root.
#[tauri::command]
fn clips_root() -> Result<Option<String>, String> {
    let Some(manifest) = load_roots_manifest() else {
        return Ok(None);
    };
    Ok(manifest
        .roots
        .values()
        .find(|e| e.mirror_of.is_some())
        .and_then(|e| e.paths.first().cloned()))
}

/// Relpaths (under the library root) of the releases ndisc has published.
/// `Ok(None)` when no manifest has been exported — the ordinary cold state, not
/// an error, and the UI simply doesn't offer the filter.
#[tauri::command]
fn released_rels() -> Result<Option<Vec<String>>, String> {
    let p = suite_shared_dir()
        .ok_or("no home directory")?
        .join("published.json");
    let Ok(raw) = fs::read_to_string(&p) else {
        return Ok(None);
    };
    let manifest: PublishedManifest =
        serde_json::from_str(&raw).map_err(|e| format!("published.json: {e}"))?;

    // Resolve each absolute release dir to (root, rel) with the same roots
    // manifest the clip→source resolution uses, so the two can never disagree
    // about where the library lives.
    let mut out = Vec::with_capacity(manifest.releases.len());
    for r in &manifest.releases {
        let res = resolve_source(r.dir.clone());
        if let Some(rel) = res.rel {
            if !rel.is_empty() {
                out.push(rel);
            }
        }
    }
    out.sort();
    out.dedup();
    Ok(Some(out))
}

// ---- suite-shared BPM store -----------------------------------------------
//
// `~/.local/share/ndisc-suite/bpm.json`. Contract + rationale live in
// nplay/schema/bpm-store-v1.md — read that before changing anything here. This
// mirrors nplay's writer deliberately (same shape, same precedence rule); the
// suite duplicates small shared pieces rather than coupling the apps.
//
// nsmpl's contribution is `source: "bars"`. That is a *human-asserted* value:
// the user declares how many bars the loop region is, and the tempo falls out
// of exact arithmetic on a loop length we know to the sample. It therefore
// outranks anything aubio detected, and nplay will not overwrite it.
//
// Crucially it is written against the **source track**, not the clip: a clip is
// an excerpt of a library track, so it is the same music at the same tempo, and
// the source's (root, relpath) is the key the rest of the suite already uses.
const BPM_STORE_VERSION: u32 = 1;
const BPM_SOURCE_BARS: &str = "bars";
const BPM_SOURCE_DETECTED: &str = "aubio";

#[derive(Serialize, Deserialize, Clone)]
struct BpmEntry {
    bpm: f64,
    source: String,
    at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BpmStore {
    version: u32,
    generated_at: i64,
    roots: BTreeMap<String, String>,
    entries: BTreeMap<String, BTreeMap<String, BpmEntry>>,
}

impl Default for BpmStore {
    fn default() -> Self {
        BpmStore {
            version: BPM_STORE_VERSION,
            generated_at: 0,
            roots: BTreeMap::new(),
            entries: BTreeMap::new(),
        }
    }
}

/// A detection may only overwrite another detection. A human-asserted value may
/// overwrite anything. Phrased as *what a detection may overwrite* rather than
/// as a list of protected names, so an unknown source is safe by default.
/// Same rule as nplay's `bpm_may_overwrite`.
fn bpm_may_overwrite(existing: &str, incoming: &str) -> bool {
    if incoming == BPM_SOURCE_DETECTED {
        return existing == BPM_SOURCE_DETECTED;
    }
    true
}

fn bpm_store_path() -> Option<PathBuf> {
    Some(suite_shared_dir()?.join("bpm.json"))
}

fn load_bpm_store() -> BpmStore {
    let Some(p) = bpm_store_path() else {
        return BpmStore::default();
    };
    let Ok(raw) = fs::read_to_string(p) else {
        // Missing is the normal cold state, not an error.
        return BpmStore::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Where a BPM for `path` belongs: the source track if `path` is a clip, else
/// the file itself. Returns (root name, relpath, absolute target path).
fn bpm_target(path: &str) -> Option<(String, String, String)> {
    let res = resolve_source(path.to_string());
    // A clip under a `mirrorOf` root → attribute the tempo to its source. Only
    // when that source actually exists: on drift (renamed/removed) we decline
    // rather than write against a path that isn't there.
    if let Some(src) = res.source_path.filter(|_| res.source_exists) {
        let sres = resolve_source(src.clone());
        return Some((sres.root?, sres.rel?, src));
    }
    Some((res.root?, res.rel?, path.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BpmWrite {
    /// Absolute path the BPM was actually recorded against (the source track
    /// when the loaded file was a clip) — so the UI can say what it did.
    target: String,
    root: String,
    rel: String,
    bpm: f64,
    /// False when an existing entry outranked this write (never for `bars`,
    /// which is human-asserted, but kept honest rather than assumed).
    written: bool,
}

/// Persist a bar-derived BPM against the source track. `bars` is human-asserted
/// ground truth, so it overwrites whatever aubio guessed.
#[tauri::command]
fn store_bars_bpm(path: String, bpm: f64) -> Result<BpmWrite, String> {
    if !(bpm.is_finite() && bpm > 0.0) {
        return Err(format!("refusing to store a nonsense BPM ({bpm})"));
    }
    let (root_name, rel, target) = bpm_target(&path).ok_or_else(|| {
        "this file isn't under a named suite root, so it has no stable \
         (root, relpath) identity to store a BPM against — see \
         ~/.config/ndisc-suite/roots.json"
            .to_string()
    })?;

    let root_abs = target
        .strip_suffix(&rel)
        .map(|s| s.trim_end_matches('/').to_string())
        .ok_or("could not derive the root's absolute path")?;

    let mut store = load_bpm_store();
    let table = store.entries.entry(root_name.clone()).or_default();
    let mut written = false;
    let existing_ok = table
        .get(&rel)
        .map(|e| bpm_may_overwrite(&e.source, BPM_SOURCE_BARS))
        .unwrap_or(true);
    if existing_ok {
        table.insert(
            rel.clone(),
            BpmEntry {
                bpm,
                source: BPM_SOURCE_BARS.to_string(),
                at: now_unix(),
            },
        );
        written = true;
    }

    if written {
        store.roots.insert(root_name.clone(), root_abs);
        store.version = BPM_STORE_VERSION;
        store.generated_at = now_unix();

        let p = bpm_store_path().ok_or("no HOME")?;
        let dir = p.parent().ok_or("bpm store has no parent dir")?;
        fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let json = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;
        // Atomic: other apps read this file, so a crash mid-write must not
        // leave a half-written document behind.
        let tmp = p.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        fs::rename(&tmp, &p).map_err(|e| format!("rename {}: {e}", p.display()))?;
    }

    Ok(BpmWrite {
        target,
        root: root_name,
        rel,
        bpm,
        written,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BpmKnown {
    bpm: f64,
    source: String,
    at: i64,
    /// The track this is recorded against — the source, when a clip is loaded.
    target: String,
}

/// What the suite already knows about this file's tempo (via its source track).
/// `Ok(None)` = nothing known, which is the ordinary case, not an error.
#[tauri::command]
fn known_bpm(path: String) -> Result<Option<BpmKnown>, String> {
    let Some((root_name, rel, target)) = bpm_target(&path) else {
        return Ok(None);
    };
    let store = load_bpm_store();
    Ok(store
        .entries
        .get(&root_name)
        .and_then(|t| t.get(&rel))
        .map(|e| BpmKnown {
            bpm: e.bpm,
            source: e.source.clone(),
            at: e.at,
            target,
        }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_audio_files,
            list_audio_files_deep,
            list_leaf_folders,
            path_exists,
            read_audio_file,
            trim_audio,
            prune_audio,
            gain_audio,
            pad_start_audio,
            pad_end_audio,
            pad_at_audio,
            render_mix,
            detect_bpm,
            get_identity,
            generate_identity,
            import_identity,
            clear_identity,
            resolve_source,
            store_bars_bpm,
            known_bpm,
            released_rels,
            clips_root,
            folder_coverage
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
