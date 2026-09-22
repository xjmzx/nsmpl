# Changelog

All notable changes to **nsmpl** (formerly `ndisc.smpl` / `smpl-tool`).

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

## 0.4.0-beta.4 — 2026-09-22

### Fixed — search missed names the filesystem holds decomposed

The file and folder filters compared raw strings, so a name stored NFD — this
library has one, `02 Wöden's Phallus.flac`, with `o` + U+0308 — did not match
the NFC form a keyboard produces, though the two render identically.

All three filters (file list, folder list, folder tally) now fold both sides at
comparison time via `src/lib/search.ts`.

**Stored paths are never normalised**: a filename on Linux is a byte string with
no canonical equivalence at the filesystem layer, so rewriting one to NFC yields
a path that does not exist. Comparison-time only. Reasoning in ndisc's
`schema/identity-normalisation-design-2026-09-22.md`.

## Unreleased

### Changed — named nsmpl everywhere it is shown

- The binary, product name, window title, macOS bundle (`nsmpl.app`), Linux
  desktop entry and icon, and the release files built from them are now
  **nsmpl**, matching the repo. They were `smpl-tool` (window title
  `ndisc.smpl`).
- **Kept on purpose:** the bundle identifier `uk.fizx.smpltool`, the keychain
  service `smpl-tool`, and the `smpl-tool.*` localStorage keys. They locate the
  saved nsec, the settings and the webview storage; renaming them would orphan
  all three.
- `make install` and `install.sh` remove the old `smpl-tool` install when they
  put the new one down.

### Fixed

- **Spawning ffmpeg no longer flashes a console window on Windows.** Windows
  gives every console program its own console, so each spawn popped one over the
  app and took focus; a pass that shells out once per file looked exactly like
  the window redrawing itself in a loop. `tools.rs` now builds its Commands
  through `quiet_command()`, which sets `CREATE_NO_WINDOW`. Carried here to keep
  the file byte-identical across nplay, nsmpl and ntree, as its header requires.
- `install_hint` stopped telling Windows users to `apt install ffmpeg`.

### Windows builds — under consideration, not offered

- The suite's release workflow can build a **Windows x86_64 NSIS installer**, and
  ndisc, nping, nplay and nchat now do. **nsmpl deliberately does not yet.**
- The app compiles clean on Windows (`cargo check` against a real Windows
  toolchain), so this is not a portability blocker — but it has never been built,
  installed or run there, and shipping an installer nobody has launched would
  claim more than is known. The job is a copy of ndisc's and can be added when
  someone is in a position to test the result.

## 0.4.0-beta.3 — 2026-09-02

### macOS builds

- The release workflow now builds a **macOS arm64 `.dmg`** alongside the Linux
  `.deb`/`.AppImage`. The macOS job runs after the Linux one and only
  appends its asset, so the Linux job stays the single owner of the release
  name and notes.
- Unsigned and un-notarised, like the rest of the suite. Gatekeeper blocks the
  first launch until the app is opened from the context menu, or cleared with
  `xattr -dr com.apple.quarantine /Applications/smpl-tool.app`.
- **This dmg is untested.** It is known to build; it is not known to run. No
  macOS build of this app has been launched.

### Fixed

- **External tools were invisible to an installed macOS `.app`.** ffmpeg, ffprobe and aubio were
  spawned by bare name, which searches the process PATH — and an app launched
  from Finder, Spotlight or the Dock inherits launchd's PATH, not a shell's, so
  Homebrew's `/opt/homebrew/bin` is not on it. `brew install ffmpeg` followed by
  the app insisting it was "not found on PATH" was the symptom. A new vendored
  `src-tauri/src/tools.rs` resolves each tool to an absolute path
  (`NDISC_TOOL_<NAME>` override, then PATH, then the well-known directories),
  and the not-found message now names the package rather than the binary, says
  where it looked, and gives the override to set. Only successful lookups are
  cached, so installing a missing tool takes effect without a restart. Linux is
  unaffected — ffmpeg lands in `/usr/bin`, which is on every PATH — which is why
  this went unseen in apps developed there.
- `workflow_dispatch` checked out the default branch while publishing to the
  tag it was handed, so a manual run uploaded main-built artifacts to an older
  tag's release. Checkout now pins `ref` to the tag being released. Tag pushes
  were never affected.

## 0.4.0-beta.2 — 2026-07-27

### Suite top-bar grammar + version chip
- The version chip shows only `major.minor.patch` (suffix → tooltip,
  `shortVersion`). The density and track-count selectors render as **bare
  Segmented** controls in the header identity zone (no icon/label prefix), shared
  placement + styling with ntree per the suite top-bar grammar; mauve active state.

### Also
- Figma icon refresh (2026-07-25); monochrome brand lockup; the video marker muted
  to the suite muted-mauve convention.

## 0.4.0-beta.1 — 2026-07-14

### Clip-coverage bars in the Library
- Browsing a release folder now shows a **clip-coverage bar** on each clip: the
  clip's **own probed length** as a fraction of its resolved source track, on a
  perceptual (sqrt) scale matching ntree. The file-list header carries a
  duration-weighted folder **rollup**.
- Durations come from a new `folder_coverage` command — header-only `ffprobe`
  on each clip plus its `resolve_source` original — run **live on folder-open**
  (no scan; nsmpl has none). Cached per folder for the session, so revisits are
  free.
- Because it probes each clip's *actual* length, it already handles the planned
  variable-length clips (5–60 s) — no constant assumed. A clip whose source
  doesn't resolve shows an empty bar with a "source not resolved" tooltip (a
  drift signal).

### Monochrome theme — and it is now the default

- **New `mono` theme**, and the title now cycles **fizx → upleb → mono**.
- **Chrome goes greyscale; MEANING keeps its colour.** Each `.theme-mono` block
  declares *only* the greyscale tokens — anything it does not redeclare keeps its
  `:root` value, so `ok` / `warn` / `alert` / `nostr` / `medium` (and ndisc's
  genre + year palettes) stay coloured with no work. **The block is a list of
  what does not mean anything.** That is the whole design.
- The brand tokens (`accent` / `mauve` / `digital` / `auburn`) were each doing two
  jobs. Hue was never their only carrier — hierarchy also lives in indent, fill,
  icons and labels — so it moves onto **luminance**: `mauve` (upper tier) sits
  brighter than `digital` (lower tier), the order the hues implied.
- **Monochrome is the DEFAULT.** No stored choice, an unrecognised one, or no
  localStorage at all → `mono`. An existing choice is respected; only a fresh
  install lands there.
- **Fixes a theme flash on every launch.** The theme class was applied in a
  `useEffect`, which runs *after* the first paint — so each launch showed the
  old default before the real theme landed, and on a fresh install that flash
  *was* the user's first impression. It is now set pre-render by an inline script
  in `index.html`, with a `catch` that falls back to mono if storage throws.

## 0.3.0-beta.9 — unreleased

### Library — fills the screen, and can be navigated
- **The main view now uses the height it has.** Collapsing the Sample and Publish
  flanks gave the Library width but never height, because two things fought it:
  the bottom row had no `flex-1` (so it sat at content height), and — the real
  culprit — the Library's list carried **`max-h-[20rem]`, capping it at ~10 rows
  no matter how much room was available**. Both gone. Collapse the flanks and the
  Library takes the full viewport in both dimensions; the list scrolls inside it.
- **Home button** → the clip tree's root. Read from the suite **roots manifest**
  (the entry that `mirrorOf`s another), *not hardcoded to `/data/music_clips`* —
  so "home" means whatever the roots say, and cannot drift out of step with
  `resolve_source`. New `clips_root` command.
- **Recents strip: two artists, two releases**, classified by depth under that
  root — one level down is an artist, two or more is a release (a multi-disc set
  surfaces `Artist/Release/Disc 1`, which is still the release you were in).
  Newest first, deduped by path, so re-entering a folder promotes it rather than
  duplicating it. Six are kept but two shown, so dipping into a third artist and
  back doesn't evict the pair you're working between. Persisted.

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
