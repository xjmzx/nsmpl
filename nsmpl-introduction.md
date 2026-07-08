# nsmpl — sample tool & publisher

> Part of the **n-suite**. Shared conventions, the Nostr wire contract, the
> design language, and the roadmap live in the hub doc:
> **[ndisc/SUITE.md](https://github.com/xjmzx/ndisc/blob/main/SUITE.md)**
> (locally: `../ndisc/SUITE.md`). This file covers **nsmpl** specifically.

`nsmpl` is a focused **two-track sample tool** for auditioning, clipping, and
**publishing** samples drawn from the suite's library — the sampling counterpart
to `ntree`, sharing its leaf/foliage vocabulary.

## What it does
- Two-track UI for lining up and clipping source audio.
- **Suite-roots clip→source resolution**: resolves a clip back to its source
  file across the shared library roots.
- Library clip-tree browse with a folder-proxy gap filter; super-slim density;
  a dominant-Library bottom row (height-matched, horizontally collapsible
  flanks).
- **Leaf/foliage** vocabulary in the Library — a cycling leaf filter and stacked
  green leaf-dot clusters marking clips/provenance.
- **Publishes** sample metadata to Nostr (NIP-94) and supports reactions.

## Tech stack & build
Tauri 2 · React + Vite + TypeScript · Rust backend · filesystem-oriented (no
SQLite) · OS keyring for the signing key · `nostr` / `nostr-tools`.
`make dev` / `make install`.

## Suite integration
- **References the library / `ndisc` releases**: clips resolve to source files
  under the shared suite roots; making the published sample explicitly reference
  its source release is a near-term provenance goal.
- Shares the **leaf/foliage** UI language with `ntree` (leaves = clips /
  provenance) and the wider palette + collapse-flanks layout.
- Reads the shared **feed**; reactions use the common `lib/rating.ts`.

## Nostr surface
Publishes **NIP-94 file metadata (kind 1063)** for samples and **reactions
(kind 7)**; reads `feed.v1` (31239). Signs with a local `nsec` in the OS keyring.

## Styling notes
Shared design language, tuned to a very slim density. Per-panel border tints
(digital / accent / muted / mauve / ok / auburn) double as a tertiary
text/accent palette. Header segmented selectors are currently icons (candidate
labels backlogged: wave/decks · fit/decks · rig/rigs).

## Backlog & direction
- Provenance: link a published sample to its source `ndisc` release.
- Expand PUBLISH attributes (role, derived-from, musical values); diagrammatic
  file-relation "leaves" tree (shared with `ntree`).
- BPM detection refinement (octave + outlier); a tap-tempo widget as a
  ground-truth BPM source (ported from BPM Tapper).
- See **[SUITE.md → Direction](https://github.com/xjmzx/ndisc/blob/main/SUITE.md#direction--roadmap)**
  for the samples → collaboration → track/release construction arc.
