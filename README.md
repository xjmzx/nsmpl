<img src="docs/nsmpl-lockup.svg" alt="nsmpl" width="300">

# nsmpl

Local audio sample tool with Nostr publishing — companion to the
[smpl.fizx.uk](https://smpl.fizx.uk) sample-sharing site.

**Stack:** Tauri 2 desktop binary + React 19 + TypeScript + Tailwind v3.
Frontend is `bun`/`npm`-friendly Vite. Native filesystem access goes
through Rust commands. Choice rationale: web tech matches the
`smpl.fizx.uk` site so Nostr/audio code is reusable, while Tauri ships
the result as a real Linux desktop app that fits the rest of the suite.

## Features

- **Browse** a local samples folder — type a path and see every audio
  file in it, or drill a folder tree (`list_audio_files` /
  `list_audio_files_deep` / `list_leaf_folders`).
- **Two-deck playback** — two WaveSurfer players plus a master strip with
  a shared play/pause, transport, cue and click-to-seek.
- **Loop regions** — drag-select an in/out region per deck; playback wraps
  the loop.
- **Edits** (ffmpeg via Rust) — trim, prune, fade in/out, gain, and pad
  start/end. A **two-track mix bounce** (`render_mix`) renders the decks
  to a single WAV.
- **BPM** — aubio auto-detect (`detect_bpm`) plus a manual bars-based
  calculator, written to the suite-shared `bpm.json` store (reused by
  `bpm-tapper` / `nplay`).
- **Suite integration** — resolves a clip back to its source release via
  `~/.config/ndisc-suite/roots.json` (`resolve_source`), and scopes to the
  releases `ndisc` has published (`released_rels`, `clips_root`).
- **Clip-coverage bars** — browsing a clip folder shows each clip's length as a
  fraction of its resolved source track (probed live on open via
  `folder_coverage`), with a folder rollup. Matches ntree's Library bar and
  handles variable clip lengths natively.
- **Nostr identity** — generate / import / forget an `nsec`, held in the
  OS keyring (never in localStorage).
- **Publish a sample to Nostr** — NIP-96 HTTP upload (default
  `nostr.build`) with NIP-98 auth, then a NIP-94 **kind:1063**
  file-metadata event over a relay, so it surfaces on
  [`smpl.fizx.uk`](https://smpl.fizx.uk) rather than reimplementing the
  reader.

## Still to come

- A dedicated **normalize** edit and general **format conversion** on
  export (the bounce currently renders WAV PCM only).
- **Reading** the shared feed (`feed.v1`, kind:31239) and reacting to
  other users' samples — today the app only publishes; there is no
  inbound-feed UI yet (`lib/rating.ts` exists but nothing consumes a
  feed).
- **Whole-tree coverage at a glance** — coverage bars are currently probed
  per open folder. A suite-shared duration index written by `ntree` (the
  scanner) would let the release list show rollups without opening each folder;
  deferred as the heavier, coordinated option.

## Install dependencies (Debian / Ubuntu)

Tauri's [Linux prerequisites](https://tauri.app/start/prerequisites/#linux):

```sh
sudo apt update
sudo apt install \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  build-essential \
  curl wget file
```

Plus a Node toolchain and a Rust toolchain:

```sh
# Node 18+ (for Vite 7 / React 19)
sudo apt install nodejs npm

# Rust (rustup is the recommended installer)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

`bun` works as a drop-in alternative to `npm` — the lockfile would
just regenerate.

## Quick start

```sh
git clone https://github.com/xjmzx/smpl-tool.git
cd smpl-tool

make deps      # npm install + cargo fetch
make dev       # opens the Tauri window with hot reload
```

## Build / install / deploy

The repo ships a `Makefile` that builds a release binary and places it
under `PREFIX/bin`, the icon under
`PREFIX/share/icons/hicolor/scalable/apps`, and a `.desktop` entry
under `PREFIX/share/applications` (so the app appears in GNOME / KDE /
XFCE app menus).

```sh
# user-level install (no sudo) — default PREFIX is $HOME/.local
make install

# system-wide
sudo make install PREFIX=/usr/local

# remove
make uninstall                     # or: sudo make uninstall PREFIX=/usr/local
```

Other targets:

```sh
make help     # list everything
make check    # tsc + vite build + cargo check (no full Tauri build)
make build    # release build only
make clean    # remove dist/ and src-tauri/target/
```

The desktop entry is generated from `smpl-tool.desktop.in` with the
install paths substituted in, so it works regardless of `PREFIX`.

## Layout

```
smpl-tool/
├── src/                   # React + TS frontend
│   ├── App.tsx           # main layout: file browser + player + edit + publish
│   ├── components/        # FileBrowser, Player, EditPanel, NostrPanel, Section
│   ├── lib/cn.ts          # clsx + tailwind-merge helper
│   └── lib/tauri.ts       # typed wrappers around invoke()
├── src-tauri/             # Rust crate (Tauri shell)
│   ├── src/lib.rs         # commands: list_audio_files
│   ├── Cargo.toml
│   └── tauri.conf.json    # window config, bundle config
├── icon.svg                       # suite-style 128px tile
├── smpl-tool.desktop.in           # .desktop template (placeholders)
└── Makefile                       # deps / dev / build / install / uninstall
```

## Companion apps in the suite

- [`bpm-tapper`](https://github.com/xjmzx/bpm-tapper)
- [`audio-flac-quality-check`](https://github.com/xjmzx/audio-flac-quality-check)
- [`disco-vault`](https://github.com/xjmzx/disco-vault)

## Related upstream

- [`smpl.fizx.uk`](https://smpl.fizx.uk) — live web client that
  consumes the kind 1063 (NIP-94) events this app publishes.
