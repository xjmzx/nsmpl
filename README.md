# smpl-tool

Local audio sample tool with Nostr publishing — companion to the
[smpl.fizx.uk](https://smpl.fizx.uk) sample-sharing site.

**Stack:** Tauri 2 desktop binary + React 19 + TypeScript + Tailwind v3.
Frontend is `bun`/`npm`-friendly Vite. Native filesystem access goes
through Rust commands. Choice rationale: web tech matches the
`smpl.fizx.uk` site so Nostr/audio code is reusable, while Tauri ships
the result as a real Linux desktop app that fits the rest of the suite.

> **Status: scaffold.** Layout, panels and a working
> `list_audio_files` Rust command are in place. Playback, edits, Nostr
> publishing buttons are wired into the UI but stubbed.

## Planned features

- Browse a local samples folder (already wired: enter a path, see all
  audio files in it).
- Playback with transport controls and seek.
- Loop region selection (set in/out, loop region).
- Edits: trim, fade in/out, normalize, format conversion (Web Audio
  API for in-app preview, ffmpeg via Rust for export).
- Publish a sample to Nostr (NIP-94 file metadata + GRASP/NIP-34 blob
  upload) so it surfaces on `smpl.fizx.uk`.
- Pair with the reader site rather than reimplement it.

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
