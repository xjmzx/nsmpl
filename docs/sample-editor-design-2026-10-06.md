# nsmpl as a sample editor — design note (2026-10-06)

> **Status: AGREED IN OUTLINE, NOT BUILT.** The scope, the render-then-listen
> model, the save-or-leave outcome, and "one codebase, Linux first" are the
> owner's decisions. Everything marked *proposed* is a starting position to be
> confirmed as it is built. No wire contract changes here; the one that may
> follow (provenance of an edited sample) is called out in §9.

## 1. Why

nsmpl grew by experiment into a two-deck tool — a master transport, tempo
matching between decks, a live mix bounce — and its audio runs entirely inside
the webview: each deck is a WaveSurfer instance driving an `HTMLMediaElement`
on a `blob:` URL holding the whole file.

That foundation has failed twice on Linux:

- **Web Audio output is silent on WebKitGTK**, so sample-accurate region loops
  were rebuilt as a `requestAnimationFrame`-polled wrap on the media element,
  with about one frame of overshoot at the loop point.
- **After a distribution upgrade moved GStreamer from 1.24 to 1.28**, loading a
  full-length FLAC (and some MP3s) draws the waveform and then fails with
  "Internal data stream error" — a parser assertion inside the webview's media
  pipeline. The same files decode and play correctly with GStreamer directly.

The second failure was nothing nsmpl did. That is the point: playback that
lives in the system webview changes whenever the system does. nplay has had
none of these problems because it plays audio in Rust (`rodio` + `symphonia`)
and uses the webview only to draw. SUITE.md already records that as the suite's
approach for audio that matters.

Scaling the app back to what it is for makes moving its audio into Rust a small
job instead of a large one. The two are done together.

## 2. What nsmpl is for

The owner's definition:

- **nsmpl is an extension of ntree.** ntree works at library scale — it
  analyses, clips, compresses and publishes samples, and lets the owner choose
  what to publish so others can find samples on a relay.
- **nsmpl works on one sample at a time, from any library** (not only the
  ndisc one): change it in ordinary, useful ways, then **publish the result
  back to the relays.**

The changes wanted are "nothing exotic": speed up or slow down *without* pitch
correction, fade in and out, filter, remove hiss, amplify.

So nsmpl is a **sample editor**. Every operation is a file transformation —
source file in, edited file out. None of them needs two things playing at once,
and none needs audio processed live.

## 3. Scope

**Keep**

- Browse a folder or a library tree; audition a file.
- Mark a region; loop it exactly.
- The edits (§5).
- BPM detection and the bars calculator, with the suite's shared BPM store.
- Suite integration: resolving a clip back to its source, coverage bars.
- Identity and publishing.

**Park** (removed from the app; the code stays in git history)

- The second deck and the master strip.
- Tempo matching and snap between decks.
- The live two-track mix and its bounce (`render_mix`).
- Recording and layering.

If combining two samples is ever wanted again, it returns as one more offline
edit (ffmpeg `amix`), not as live decks.

**Not goals**

- A DAW, a multitrack, or a DJ tool.
- Live effect preview while a control is dragged (§4).
- Pitch-preserving time-stretch. Available later if asked for (`atempo` or
  `rubberband`); the owner asked for speed *with* pitch following.

## 4. The working model

```
open ─▶ audition ─▶ build an edit list ─▶ render ─▶ audition the result
                                                       │
                                     ┌─────────────────┴────────────────┐
                                     ▼                                  ▼
                               save a version                    leave unchanged
                                     │
                                     ▼
                                  publish
```

- **Render, then listen.** *(Decided.)* Applying the edit list runs ffmpeg once
  and produces a temporary file; that file is what is auditioned. For a short
  sample this takes well under a second. Nothing is processed live, which is
  where the latency and most of the complexity lived.
- **Two outcomes only.** *(Decided.)* After listening, the owner either **saves
  a version** or **leaves the sample unchanged**. There is no third state: an
  unsaved render is discarded when the sample is closed or the edit list is
  cleared.
- **A/B.** The original and the render can be switched between while playing,
  at the same position (scaled when the edit changed the length).
- **The source is never modified.** Saving writes a new file (§7). This is the
  suite's standing rule for the source library, and it is a change from today:
  the current edits write `{stem}-gain.{ext}` and the like *next to the
  source*.

## 5. The edits

One list, applied in order, rendered in a single ffmpeg pass. Each entry is an
operation and its parameters; the list is the unit that is saved, shown and —
later — published as provenance.

| Edit | Parameters | ffmpeg | Today |
|---|---|---|---|
| Trim to region | start, end | `atrim` + `asetpts` | have |
| Cut a region out | start, end | `atrim` × 2 + `concat` | have (`prune`) |
| Fade in / out | duration, curve | `afade` | have |
| Gain | dB | `volume` | have |
| Normalise | target level | `loudnorm`, or peak via `volumedetect` + `volume` | new |
| Pad with silence | start / end / at, duration | `adelay`, `apad` | have |
| Speed | factor | `asetrate` + `aresample` — pitch follows speed | new |
| High-pass / low-pass | cutoff | `highpass`, `lowpass` | new |
| Remove hiss | strength | `afftdn` (or `anlmdn`) | new |

*Proposed* order when the owner has not arranged the list by hand: trim and cut
first (less audio for everything after), then speed, filters and hiss removal,
then gain or normalise, then fades and padding last (so a fade is not undone by
a later normalise).

Hiss removal is the one edit whose result is hard to predict from a number. It
gets a small set of named strengths rather than a free slider, so a render is a
choice between three or four listenable options, not a search.

A speed change alters tempo: when the sample has a stored BPM, the saved
version's BPM is the original multiplied by the speed factor.

## 6. Audio and the waveform

*Proposed.*

- **Playback in Rust.** Decode the file to PCM in memory (`symphonia`, as nplay
  does) and play it through `rodio`/`cpal`. Samples are short, so holding them
  decoded is cheap; a five-minute source track is about 100 MB as 32-bit float
  stereo and still acceptable for one file at a time.
- **Loops are exact** because the loop is over the decoded samples: the region
  is a pair of sample indices, and the player wraps from one to the other with
  no gap and no polling.
- **Position** is reported to the interface from the audio callback's sample
  counter, at display rate.
- **One player.** The original and the render are two buffers behind it; A/B
  swaps which one is being read.
- **Peaks from Rust.** The waveform is a min/max pair per pixel column,
  computed once per buffer from the decoded samples and drawn on a plain
  canvas. The page never decodes audio and never holds the file.
- **WaveSurfer goes**, along with the media element, the blob loading and the
  Web Audio metadata decode. Region selection becomes a small piece of our own
  canvas code.

The risk in this section is concentrated in one place — a looping player with
accurate position reporting on all three platforms — so it is built first, as a
prototype, before any interface work (§10).

## 7. Files and versions

*Proposed; the location is the part most likely to change.*

- **A saved version is a new file in a workspace folder**, mirroring the
  source's relative path the way the clip tree does: the suite's roots manifest
  gains a "versions" root, and `Artist/Album/track.flac` saves to
  `<versions>/Artist/Album/track.v01.flac`, then `v02`, and so on. For a file
  outside any known root, the version is saved beside a workspace-relative copy
  of its folder name, never beside the source.
- **Each version has a sidecar**, `track.v01.json`: the source's path and
  content hash, the edit list with its parameters, the ffmpeg version, and the
  time. That makes a version reproducible, and it is the raw material for
  provenance (§9).
- **Format:** FLAC for the saved version. An AAC web copy (`.m4a`, the format
  ntree's Compress step writes) is made at publish time when the upload should
  be the small one. A lossy source stays honest: editing an MP3 produces a FLAC
  of that MP3's audio, and the sidecar records the source codec.

## 8. Publishing

- The published event is still NIP-94 file metadata (kind 1063), as today.
- **Hosting moves to Blossom.** nsmpl and ntree upload through NIP-96 to a
  third-party host; the suite now runs its own Blossom server, and ndisc
  already has the client (`blossom.rs` — signed authorisation, upload, hash
  check). nsmpl takes the same ordered server list from its settings: first is
  the primary, the rest are mirrors.
- Publishing is always a separate, deliberate step. Saving a version publishes
  nothing.

## 9. Provenance — open

An edited sample should say what it was made from. Two links are possible and
they are not the same thing:

- to the **release** the audio came from (the `a`-reference `clip.v1` already
  defines), and
- to the **sample it was edited from**, when that was itself published (an
  `e`-reference to the earlier kind 1063 event).

Whether the edit list itself is published — as tags, or as a pointer to the
sidecar — is also open. `clip.v1` is provisionally pinned and not yet frozen;
this belongs in that contract's design, in ndisc's `schema/`, and is decided
there rather than here. Until then nsmpl publishes what it publishes today plus
nothing new, and keeps the sidecar so the link can be added later without
re-editing.

## 10. Order of work

1. **Playback prototype** — a Rust command set that loads a file, plays it,
   loops a region exactly, reports position, and swaps between two buffers.
   Driven from a bare test page. Proven on Linux first; then built on macOS.
2. **Peaks and the canvas waveform**, with region selection.
3. **The edit list and the single-pass render**, starting with the edits that
   exist today, then speed, filters, normalise and hiss removal.
4. **Versions and sidecars.**
5. **The interface**, rebuilt around one player: source and render side by
   side, the edit list between them, save or leave.
6. **Blossom upload** in place of NIP-96.
7. **Remove** the second deck, the master strip, match/snap, the live mix,
   WaveSurfer and the media-element path.

This is a breaking redesign of the app and ships as a new minor version line.
Steps 1–2 can land behind the existing interface without changing what a user
sees, which keeps the app usable on macOS and Windows while Linux is fixed.

## 11. Platforms

- **One codebase.** *(Decided.)* The same Tauri app, with playback in Rust,
  built on each platform — Linux first, because Linux is the platform whose
  webview is weakest for audio, so what works there works elsewhere. Rust audio
  reaches the native audio system on each OS directly (PipeWire/ALSA,
  CoreAudio, WASAPI), so every build gets native playback from shared code.
- **A pass on macOS says nothing about Linux.** Tests of anything audible are
  run on Linux; macOS and Windows confirm.
- ffmpeg stays an external tool, resolved the way the suite already does
  (`tools.rs`), with the edits degrading to a clear "ffmpeg not found" rather
  than a silent failure.

## 12. Open questions

1. Where versions live (§7): a new suite root, or a folder per library.
2. Whether a version of a *clip* and a version of a *source track* are stored
   the same way.
3. Provenance on the wire (§9).
4. Whether Normalise means loudness (`loudnorm`) or peak — or both, as two
   named choices.
5. What the interface shows for a source too long to hold decoded (hours):
   refuse, or fall back to streaming without exact loops.
