import { useEffect, useState } from "react";
import { Check, Copy, Radio, Upload } from "lucide-react";
import { Section } from "./Section";
import { readAudioFile, type AudioFile } from "../lib/tauri";
import {
  DEFAULT_NIP96_ENDPOINT,
  publishFileMetadata,
  uploadToNip96,
  type Identity,
  type PublishResult,
} from "../lib/nostr";
import { cn } from "../lib/cn";

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

const MIME_BY_EXT: Record<string, string> = {
  wav: "audio/wav",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  wv: "audio/x-wavpack",
};

function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

type Status =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "uploading" }
  | { kind: "publishing" }
  | { kind: "ok"; result: PublishResult; uploadUrl: string }
  | { kind: "err"; message: string };

interface NostrPanelProps {
  file: AudioFile | null;
  identity: Identity | null;
}

export function NostrPanel({ file, identity }: NostrPanelProps) {
  const [relays, setRelays] = useState<string[]>(DEFAULT_RELAYS);
  const [newRelay, setNewRelay] = useState("");
  const [endpoint, setEndpoint] = useState(DEFAULT_NIP96_ENDPOINT);

  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [copied, setCopied] = useState<string | null>(null);

  // Default the title to the filename stem when a sample is selected.
  useEffect(() => {
    if (!file) return;
    const stem = file.name.replace(/\.[^.]+$/, "");
    setTitle((prev) => (prev.trim() ? prev : stem));
  }, [file?.path]);

  function addRelay() {
    const url = newRelay.trim();
    if (!url || relays.includes(url)) return;
    setRelays([...relays, url]);
    setNewRelay("");
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* clipboard denied */
    }
  }

  async function handlePublish() {
    if (!identity || !file) return;
    if (!title.trim()) {
      setStatus({ kind: "err", message: "title is required" });
      return;
    }
    if (relays.length === 0) {
      setStatus({ kind: "err", message: "add at least one relay" });
      return;
    }

    try {
      setStatus({ kind: "reading" });
      const bytes = await readAudioFile(file.path);

      setStatus({ kind: "uploading" });
      const upload = await uploadToNip96(
        identity.sk,
        bytes,
        file.name,
        mimeFor(file.name),
        endpoint,
      );

      setStatus({ kind: "publishing" });
      const result = await publishFileMetadata({
        sk: identity.sk,
        upload,
        title: title.trim(),
        relays,
      });

      setStatus({ kind: "ok", result, uploadUrl: upload.url });
    } catch (e) {
      setStatus({ kind: "err", message: String(e) });
    }
  }

  const busy =
    status.kind === "reading" ||
    status.kind === "uploading" ||
    status.kind === "publishing";

  return (
    <Section title="Publish · Nostr" icon={<Radio size={16} />}>
      {/* ---- Relays ---- */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted mb-1">
          Relays
        </div>
        <ul className="space-y-1 mb-2">
          {relays.map((r) => (
            <li
              key={r}
              className="px-2 py-1 rounded bg-bg/50 font-mono text-xs flex
                         items-center justify-between gap-2"
            >
              <span className="truncate">{r}</span>
              <button
                onClick={() => setRelays(relays.filter((x) => x !== r))}
                className="text-muted hover:text-alert text-xs"
                aria-label={`Remove ${r}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <input
            type="text"
            value={newRelay}
            onChange={(e) => setNewRelay(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addRelay()}
            placeholder="wss://relay.example.com"
            className="flex-1 px-3 py-1.5 rounded-md bg-surface text-fg
                       placeholder:text-muted outline-none border border-transparent
                       focus:border-accent/50 text-xs font-mono"
            spellCheck={false}
          />
          <button
            onClick={addRelay}
            disabled={!newRelay.trim()}
            className="px-3 py-1.5 rounded-md bg-surface hover:bg-surfaceHover
                       text-fg disabled:opacity-50 text-xs"
          >
            Add
          </button>
        </div>
      </div>

      {/* ---- NIP-96 server ---- */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted mb-1">
          NIP-96 server
        </div>
        <input
          type="text"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          className="w-full px-3 py-1.5 rounded-md bg-surface text-fg
                     placeholder:text-muted outline-none border border-transparent
                     focus:border-accent/50 text-xs font-mono"
          spellCheck={false}
        />
      </div>

      {/* ---- Title ---- */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted mb-1">
          Title
        </div>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={file ? file.name : "select a sample first"}
          disabled={!file}
          className="w-full px-3 py-1.5 rounded-md bg-surface text-fg
                     placeholder:text-muted outline-none border border-transparent
                     focus:border-accent/50 text-xs disabled:opacity-50"
        />
      </div>

      {/* ---- Publish ---- */}
      <button
        onClick={handlePublish}
        disabled={!identity || !file || busy}
        className={cn(
          "w-full px-3 py-2.5 rounded-md font-semibold",
          "flex items-center justify-center gap-2",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          status.kind === "ok"
            ? "bg-ok/20 text-ok"
            : status.kind === "err"
              ? "bg-alert/20 text-alert"
              : "bg-accent text-bg hover:opacity-90",
        )}
      >
        <Upload size={16} />
        {status.kind === "reading"
          ? "reading file…"
          : status.kind === "uploading"
            ? "uploading…"
            : status.kind === "publishing"
              ? "publishing…"
              : status.kind === "ok"
                ? "published ✓"
                : status.kind === "err"
                  ? "failed — try again"
                  : !identity
                    ? "load a key in the Identity panel first"
                    : !file
                      ? "select a sample"
                      : "Publish to Nostr"}
      </button>

      {status.kind === "err" && (
        <pre className="text-xs text-alert font-mono break-all whitespace-pre-wrap">
          {status.message}
        </pre>
      )}

      {status.kind === "ok" && (
        <div className="space-y-1.5 text-xs">
          <Result
            label="event"
            value={status.result.nevent}
            k="nevent"
            copy={copy}
            copied={copied}
          />
          <Result
            label="file"
            value={status.uploadUrl}
            k="url"
            copy={copy}
            copied={copied}
          />
          <div className="space-y-0.5">
            {status.result.relays.map((r) => (
              <div
                key={r.url}
                className="flex items-center justify-between gap-2 font-mono text-[10px]"
              >
                <span className="truncate text-muted">{r.url}</span>
                {r.ok ? (
                  <span className="text-ok shrink-0">✓ accepted</span>
                ) : (
                  <span
                    className="text-alert shrink-0 truncate max-w-[60%]"
                    title={r.reason}
                  >
                    ✗ {r.reason}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

function Result({
  label,
  value,
  k,
  copy,
  copied,
}: {
  label: string;
  value: string;
  k: string;
  copy: (t: string, k: string) => void;
  copied: string | null;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded bg-bg/50">
      <span className="text-muted text-[10px] uppercase tracking-wide w-12 shrink-0">
        {label}
      </span>
      <span className="font-mono text-[10px] truncate flex-1" title={value}>
        {value}
      </span>
      <button
        onClick={() => copy(value, k)}
        className="text-muted hover:text-fg shrink-0"
      >
        {copied === k ? <Check size={11} /> : <Copy size={11} />}
      </button>
    </div>
  );
}
