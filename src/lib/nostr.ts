// Nostr publishing for smpl-tool.
//
//   Identity:   local nsec held in localStorage (scaffold-grade — move to
//               OS keyring / nostr-tools NIP-46 / Tauri Stronghold later).
//   Upload:     NIP-96 (HTTP file storage); default endpoint nostr.build.
//   Auth:       NIP-98 (HTTP Auth event, kind 27235) with payload hash.
//   Publish:    NIP-94 (kind 1063 file metadata) over plain WebSocket.
//
// Mirrors the upload + publish flow used by https://smpl.fizx.uk (which
// signs via NIP-07 browser extension instead) so events surface there.

import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip19,
  type EventTemplate,
} from "nostr-tools";

export const DEFAULT_NIP96_ENDPOINT = "https://nostr.build/api/v2/nip96/upload";
const KEY_STORAGE = "smpl-tool.nsec";

export interface Identity {
  sk: Uint8Array;
  pk: string;
  nsec: string;
  npub: string;
}

function fromSecret(sk: Uint8Array, nsec: string): Identity {
  const pk = getPublicKey(sk);
  return { sk, pk, nsec, npub: nip19.npubEncode(pk) };
}

export function loadIdentity(): Identity | null {
  const stored = localStorage.getItem(KEY_STORAGE);
  if (!stored) return null;
  try {
    const decoded = nip19.decode(stored);
    if (decoded.type !== "nsec") return null;
    return fromSecret(decoded.data as Uint8Array, stored);
  } catch {
    return null;
  }
}

/** Accept either bech32 `nsec1…` or 64-char hex. */
export function saveKey(input: string): Identity {
  const trimmed = input.trim();
  let sk: Uint8Array;
  let nsec: string;

  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") {
      throw new Error("malformed nsec");
    }
    sk = decoded.data as Uint8Array;
    nsec = trimmed;
  } else if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    sk = new Uint8Array(
      trimmed
        .toLowerCase()
        .match(/.{2}/g)!
        .map((b) => parseInt(b, 16)),
    );
    nsec = nip19.nsecEncode(sk);
  } else {
    throw new Error("expected nsec1… or 64-char hex");
  }

  localStorage.setItem(KEY_STORAGE, nsec);
  return fromSecret(sk, nsec);
}

export function generateIdentity(): Identity {
  const sk = generateSecretKey();
  const nsec = nip19.nsecEncode(sk);
  localStorage.setItem(KEY_STORAGE, nsec);
  return fromSecret(sk, nsec);
}

export function clearIdentity(): void {
  localStorage.removeItem(KEY_STORAGE);
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
  event: { id: string; [k: string]: unknown },
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
