// Nostr publishing for smpl-tool.
//
//   Identity:   nsec held in the OS keychain (libsecret on Linux) via
//               the Rust `keyring` crate. Dev builds use a separate
//               keychain service so `make dev` runs don't read or
//               overwrite the installed binary's identity. Mirrors
//               ndisc / audio-flac-quality-check-tauri.
//   Upload:     NIP-96 (HTTP file storage); default endpoint nostr.build.
//   Auth:       NIP-98 (HTTP Auth event, kind 27235) with payload hash.
//   Publish:    NIP-94 (kind 1063 file metadata) over plain WebSocket.
//
// Mirrors the upload + publish flow used by https://smpl.fizx.uk (which
// signs via NIP-07 browser extension instead) so events surface there.

import { invoke } from "@tauri-apps/api/core";
import { finalizeEvent, nip19, type EventTemplate } from "nostr-tools";

export const DEFAULT_NIP96_ENDPOINT = "https://nostr.build/api/v2/nip96/upload";
const LEGACY_NSEC_KEY = "smpl-tool.nsec";

export interface Identity {
  sk: Uint8Array;
  pk: string;
  nsec: string;
  npub: string;
}

interface RustIdentity {
  npub: string;
  pk: string;
  sk: string; // hex
  nsec: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function fromRust(r: RustIdentity): Identity {
  return { sk: hexToBytes(r.sk), pk: r.pk, nsec: r.nsec, npub: r.npub };
}

let migrationAttempted = false;

/** One-time migration: if the keychain is empty but the legacy
 *  localStorage nsec exists, import it into the keychain and clear the
 *  legacy entry. Silent failure leaves the legacy entry in place. */
async function migrateLegacyIfNeeded(): Promise<void> {
  if (migrationAttempted) return;
  migrationAttempted = true;
  try {
    const current = await invoke<RustIdentity | null>("get_identity");
    if (current) return;
    const legacy = localStorage.getItem(LEGACY_NSEC_KEY);
    if (!legacy) return;
    await invoke<RustIdentity>("import_identity", { nsec: legacy });
    localStorage.removeItem(LEGACY_NSEC_KEY);
  } catch {
    /* leave legacy in place */
  }
}

export async function loadIdentity(): Promise<Identity | null> {
  await migrateLegacyIfNeeded();
  const r = await invoke<RustIdentity | null>("get_identity");
  return r ? fromRust(r) : null;
}

/** Accept either bech32 `nsec1…` or 64-char hex. */
export async function saveKey(input: string): Promise<Identity> {
  const trimmed = input.trim();
  let nsec: string;
  if (trimmed.startsWith("nsec1")) {
    nsec = trimmed;
  } else if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const sk = hexToBytes(trimmed.toLowerCase());
    nsec = nip19.nsecEncode(sk);
  } else {
    throw new Error("expected nsec1… or 64-char hex");
  }
  const r = await invoke<RustIdentity>("import_identity", { nsec });
  return fromRust(r);
}

export async function generateIdentity(): Promise<Identity> {
  const r = await invoke<RustIdentity>("generate_identity");
  return fromRust(r);
}

export async function clearIdentity(): Promise<void> {
  return invoke("clear_identity");
}

// ---- Hash + auth -------------------------------------------------

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function nip98AuthHeader(
  sk: Uint8Array,
  url: string,
  method: string,
  payloadHash: string,
): Promise<string> {
  const tmpl: EventTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", url],
      ["method", method],
      ["payload", payloadHash],
    ],
    content: "",
  };
  const event = finalizeEvent(tmpl, sk);
  return "Nostr " + btoa(JSON.stringify(event));
}

// ---- NIP-96 upload -----------------------------------------------

interface Nip96Tag {
  0: string;
  1?: string;
}

interface Nip96Response {
  status?: string;
  message?: string;
  nip94_event?: { tags?: Nip96Tag[] };
  data?: { url?: string }[];
  url?: string;
}

export interface UploadResult {
  url: string;
  hash: string;
  size: number;
  mime: string;
}

export async function uploadToNip96(
  sk: Uint8Array,
  bytes: ArrayBuffer,
  filename: string,
  mime: string,
  endpoint: string = DEFAULT_NIP96_ENDPOINT,
): Promise<UploadResult> {
  const hash = await sha256Hex(bytes);
  const auth = await nip98AuthHeader(sk, endpoint, "POST", hash);

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), filename);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: auth },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upload ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as Nip96Response;
  const url =
    json?.nip94_event?.tags?.find((t) => t[0] === "url")?.[1] ??
    json?.data?.[0]?.url ??
    json?.url;
  if (!url) {
    throw new Error("upload succeeded but no URL returned");
  }
  return { url, hash, size: bytes.byteLength, mime };
}

// ---- NIP-94 publish ---------------------------------------------

export interface PublishParams {
  sk: Uint8Array;
  upload: UploadResult;
  title: string;
  description?: string;
  relays: string[];
}

export interface RelayResult {
  url: string;
  ok: boolean;
  reason?: string;
}

export interface PublishResult {
  eventId: string;
  nevent: string;
  relays: RelayResult[];
}

export async function publishFileMetadata(
  p: PublishParams,
): Promise<PublishResult> {
  const tags: string[][] = [
    ["url", p.upload.url],
    ["m", p.upload.mime],
    ["x", p.upload.hash],
    ["size", String(p.upload.size)],
    ["title", p.title],
  ];

  const event = finalizeEvent(
    {
      kind: 1063,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: p.description?.trim() || p.title,
    },
    p.sk,
  );

  const relays = await Promise.all(
    p.relays.map((url) => sendToRelay(url, event)),
  );

  return {
    eventId: event.id,
    nevent: nip19.neventEncode({
      id: event.id,
      author: event.pubkey,
      relays: p.relays,
      kind: event.kind,
    }),
    relays,
  };
}

function sendToRelay(
  url: string,
  event: { id: string },
  timeoutMs = 8000,
): Promise<RelayResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RelayResult) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      resolve({ url, ok: false, reason: String(e) });
      return;
    }

    const timer = setTimeout(
      () => finish({ url, ok: false, reason: "timeout" }),
      timeoutMs,
    );

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify(["EVENT", event]));
      } catch (e) {
        clearTimeout(timer);
        finish({ url, ok: false, reason: String(e) });
      }
    };
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (Array.isArray(data) && data[0] === "OK" && data[1] === event.id) {
          clearTimeout(timer);
          if (data[2]) {
            finish({ url, ok: true });
          } else {
            finish({ url, ok: false, reason: String(data[3] ?? "rejected") });
          }
        }
      } catch {
        /* not JSON or not for us */
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      finish({ url, ok: false, reason: "connection error" });
    };
    ws.onclose = () => {
      clearTimeout(timer);
      finish({ url, ok: false, reason: "closed before OK" });
    };
  });
}
