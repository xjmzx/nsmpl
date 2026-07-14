# Changelog

All notable changes to **nsmpl** (formerly `ndisc.smpl` / `smpl-tool`; the
binary is still `smpl-tool`).

nsmpl publishes **NIP-94 (kind:1063)** file metadata and **kind:7** reactions,
but it is *not* a participant in ndisc's `release.vN` wire contract — it
describes files, not releases. So it tracks a single axis: this app's own semver,
below. Where it does share a contract with the suite, that is named in the entry
(currently `bpm-store-v1`, defined in `nplay/schema/bpm-store-v1.md`).

> **Note on the entries below.** This file was started at **0.3.0-beta.7**
> (2026-07-13), by which point the app was already well past its first release.
> Everything from **beta.6** down is **reconstructed from git history and the
> tag ranges** — the `Cut 0.3.0-beta.N` commits carry good bodies, so the
> substance is accurate, but these are summaries written after the fact rather
> than notes taken at the time. Treat the git log as canonical if they ever
> disagree. **0.3.0-beta.1** and **0.3.0-beta.6** were never tagged.

## 0.3.0-beta.8 — unreleased

### Awareness of ndisc's published discography (read-only)
- **New `released` filter** in the Library's folder mode: narrows the clip tree to
  the releases ndisc has published to Nostr (kind:31237) — 1,609 here, out of
  2,455 clip folders on disk.
- Reads ndisc's suite-shared manifest (`~/.local/share/ndisc-suite/published.json`)
  rather than its database, so nsmpl never couples to that schema. No manifest,
  no chip: a control that silently matches nothing is worse than no control.
- **Resolved through `roots.json`**, not by slicing paths — the same roots
  manifest that powers clip→source resolution, so the two can never disagree
  about where the library lives. Returns **relpaths**, so the frontend never
  needs to know about two roots. Membership **walks up** the path, because a
  multi-disc release surfaces `Artist/Release/Disc 1` as the leaf while the
  manifest names `Artist/Release`.

### nsmpl is read-only about Nostr publish state — on purpose
- nsmpl edits audio; it does not own a publish lifecycle. It publishes NIP-94
  (kind:1063) but deliberately records **no** publish state, and will not grow
  one: a boolean "I think I published this" at 12k-clip scale is exactly the
  problem ndisc's four-state model (never/published/stale/retracted, judged by
  event id against the relays) exists to solve. Knowing what ndisc has *released*
  is enough to scope the Library.
- The nsec stays in the keychain (dev/release service split intact) — write
  paths remain open for later; this is a decision about *state ownership*, not
  about capability.

## 0.3.0-beta.7 — unreleased

### BPM — the bar-derived tempo is finally persisted
- **nsmpl has carried a manual bars-based BPM since long before the rest of the
  suite met the same problem** — `BPM = (bars × 4 ÷ loopLen) × 60`, with the code
  itself calling it *"a workaround while aubio-based auto detection remains
  parked"*. It was **ephemeral UI state, thrown away on every file change**. It
  is now written to the suite-shared store.
- **It is not a lesser tap-tempo — it is arguably better.** A tap is a human
  *estimate*; bars is a human *assertion* (the bar count) plus exact arithmetic
  on a loop length known to the sample. So it is recorded as **`source: "bars"`**
  — human-asserted ground truth, which a detection (`aubio`) may **never**
  overwrite. Contract: `nplay/schema/bpm-store-v1.md`; store lives at
  `~/.local/share/ndisc-suite/bpm.json`.
- **Written against the SOURCE TRACK, not the clip.** A clip is a 10s excerpt of
  a library track — same music, same tempo — and the source's `(root, relpath)`
  is the key the rest of the suite already uses. `resolve_source` already walked
  the `mirrorOf` link in `~/.config/ndisc-suite/roots.json`, so a BPM derived
  from a clip lands on `/data/music`. It matches by *stem*, so it crosses a
  format change (`.flac` clip → `.mp3` source) too.
- **Drift is declined, not guessed**: if the source has been renamed or removed,
  the write is refused rather than aimed at a path that isn't there.
- **Pinning is an explicit act, never automatic.** The displayed BPM changes with
  every bar-count cycle and most of those intermediate values are wrong by
  construction, so auto-saving would fill the store with numbers the user was
  only passing through.
- **The pin chip always shows what is stored** — `127` (mauve: human-asserted)
  vs `131?` (muted: an aubio guess, which is the thing the control exists to
  correct) vs nothing at all.
- New Rust commands: `store_bars_bpm`, `known_bpm`.

## 0.3.0-beta.6 — unreleased (never tagged; 2026-06-16 → 2026-07-10)

A long, untagged stretch. Broadly: the suite-roots model, the Library as a
clip-tree, the leaf vocabulary, a vertical diet, and the `nsmpl` rename.

### Suite roots — clips know where they came from
- **Clip → source resolution via the shared roots manifest**
  (`~/.config/ndisc-suite/roots.json`): named roots with a `mirrorOf` link
  (`music_clips` mirrors `music`), so a clip resolves back to the library track
  it was cut from. Tolerant consumer — a missing or malformed manifest yields
  "no resolution", never an error. *(This is what beta.7's BPM writer stands on.)*
- SAMPLE panel shows the `(root, relpath)` source; Sample / Publish flanks
  equalised.

### Library
- **Clip-tree + leaf-folder listing backend** — browse a whole tree (e.g.
  `/data/music_clips` at the artist level) rather than one flat directory.
  Folder-view + bottom-row layout, with collapse and density wiring.
- **Leaf vocabulary** — leaf quantity as stacked dots, an adaptive `LeafDots`
  packer, `maxRows` tile-collapse, and a right-to-left fill synced with ndisc's
  shared glyph.

### Media
- **Video files recognised and displayed** (the full media spectrum). Shared
  `VIDEO_EXTS` with the rest of the suite; markers only — nsmpl does not sample
  or play video.

### UI
- Master Control moved into the header; a **vertical diet** across all density
  tiers; a **super-slim** density; **horizontal collapse** for the Sample /
  Publish flanks.
- Renamed **ndisc.smpl → nsmpl** (header title, dock name); app icon refreshed
  repeatedly from the Figma suite master.
- `nsmpl-introduction.md` added (n-suite orientation preamble).

## 0.3.0-beta.5 — 2026-05-27

- **Collapse no longer wedges the audio engine.** The Player body is now always
  rendered and hidden with CSS (`display:none`) rather than unmounted, so
  WaveSurfer stays bound to its container and the listeners + rAF envelope loop
  survive. Fixes the intermittent "track refuses to play/stop after collapse".
- **Master Reset** — destroys and recreates both WaveSurfer instances from their
  current files. A recovery escape hatch: preserves file / fades / match, clears
  loop regions.
- **Mute, per-track and master.** The transport's `Volume2` icon toggles mute
  (swapping to `VolumeX`, alert-tinted) while preserving the slider value.
  Effective mute is `trackMuted || masterMuted` — an OR, so the master never
  disturbs local toggles.
- Bar snap; master strip restyle.

## 0.3.0-beta.4 — 2026-05-27

- **Render mix-down — the first cut at a deferred bake.** New `render_mix` Rust
  command (ffmpeg `amix=normalize=0` + a per-input filter chain) wraps each
  track's loop region and non-destructive envelope into a fresh `{stem}-mix.wav`.
  The `MixInput` struct keeps the IPC stable as the envelope surface grows.
- **Bounce** button on the MasterStrip (2-track) and the per-track transport
  (1-track), with a `BounceStatus` component showing the four-state lifecycle:
  idle / running with an elapsed ticker / done with a fading "saved: …" / failed
  with a persistent error.
- **Non-destructive fade envelope** — a new `EnvelopeStrip` above each waveform,
  with draggable handles at each ramp's inner endpoint.

## 0.3.0-beta.3 — 2026-05-27

- **Layout reshape.** Master strip moved out from *between* Track 1 and Track 2
  to a full-width bar *above* them — honest hierarchy, and it stops splitting the
  two-track pair. The two-column body collapsed so tracks span the full width,
  giving waveforms more horizontal detail.
- **Library relocated** to the bottom-row middle slot alongside Sample and
  Publish (1fr / 2fr / 1fr, so Library claims the wider middle column).
- The `aux` placeholder removed entirely.
- Library density trimmed back to padding + control sizing; the aggressive
  list/row magnification "didn't read well in practice".

## 0.3.0-beta.2 — 2026-05-26

- **First proper Release.** Adopts ndisc's `release.yml` workflow verbatim: fires
  on `v*` tags, builds `.deb` + `.AppImage` on ubuntu-22.04, publishes via
  `softprops/action-gh-release` with an auto-detected prerelease flag.
- Rolls forward the master-strip polish, the **BPM bars-calc** *(the mechanism
  beta.7 finally persists)*, and an identity-load diagnostic.

## 0.3.0-beta.1 — never tagged

- **Destructive bakes**: pad start / end / at-region (`adelay` + `apad` +
  `filter_complex` split-concat); a combined fade+tail op; **match length to the
  other track** (one-click pad-end or trim to make two same-tempo loops
  congruent).
- **Master strip** between the two tracks — cue / play-pause / stop, with master
  play as a true toggle driven by aggregate playing state.
- BPM detection chip left visible but **disabled** behind a
  `BPM_DETECTION_ENABLED` constant, aubio's octave errors having made it
  untrustworthy. *(The constant is long gone; the bars calc replaced it.)*
