import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  Radio,
  Sparkles,
  Upload,
} from "lucide-react";
import { Section } from "./Section";
import { readAudioFile, type AudioFile } from "../lib/tauri";
import {
  clearIdentity,
  DEFAULT_NIP96_ENDPOINT,
  generateIdentity,
  publishFileMetadata,
  saveKey,
  uploadToNip96,
  type Identity,
  type PublishResult,
} from "../lib/nostr";
import { cn } from "../lib/cn";

function shortNpub(npub: string): string {
  return npub.length > 28 ? `${npub.slice(0, 14)}…${npub.slice(-8)}` : npub;
}

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
  setIdentity: (id: Identity | null) => void;
}

export function NostrPanel({ file, identity, setIdentity }: NostrPanelProps) {
  const [relays, setRelays] = useState<string[]>(DEFAULT_RELAYS);
  const [newRelay, setNewRelay] = useState("");
  const [endpoint, setEndpoint] = useState(DEFAULT_NIP96_ENDPOINT);

  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [copied, setCopied] = useState<string | null>(null);

  // Identity sub-section state (moved here from the former InfoPanel
  // identity block — keeps the key UI adjacent to the action that needs it).
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [revealNew, setRevealNew] = useState(false);
  const [showStoredSecret, setShowStoredSecret] = useState(false);

  async function handleLoadKey() {
    setKeyError(null);
    try {
      const id = await saveKey(keyInput);
      setIdentity(id);
      setKeyInput("");
      setRevealNew(false);
      setShowStoredSecret(false);
    } catch (e) {
      setKeyError(String(e));
    }
  }
  async function handleGenerateKey() {
    setKeyError(null);
    try {
      const id = await generateIdentity();
      setIdentity(id);
      setShowStoredSecret(true); // user needs to back this up
    } catch (e) {
      setKeyError(String(e));
    }
  }
  async function handleForgetKey() {
    if (
      !confirm(
        "Forget this nsec from the OS keychain? Make sure you've backed it up.",
      )
    ) {
      return;
    }
    try {
      await clearIdentity();
      setIdentity(null);
      setShowStoredSecret(false);
    } catch (e) {
      setKeyError(String(e));
    }
  }

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
      {/* ---- Identity ---- */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted mb-1">
          Identity
        </div>
        {identity ? (
          <div className="space-y-2">
            <div className="px-2 py-1.5 rounded-md bg-bg/50 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-muted">
                  npub
                </div>
                <div
                  className="font-mono text-xs truncate"
                  title={identity.npub}
                >
                  {shortNpub(identity.npub)}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <IconBtn
                  title="Copy npub"
                  onClick={() => copy(identity.npub, "npub")}
                >
                  {copied === "npub" ? (
                    <Check size={12} />
                  ) : (
                    <Copy size={12} />
                  )}
                </IconBtn>
                <IconBtn
                  title="Forget this key"
                  onClick={handleForgetKey}
                  danger
                >
                  <LogOut size={12} />
                </IconBtn>
              </div>
            </div>

            <div className="px-2 py-1.5 rounded-md bg-bg/50">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-wide text-warn">
                  nsec (secret)
                </span>
                <div className="flex gap-1">
                  <IconBtn
                    title={showStoredSecret ? "Hide" : "Reveal nsec"}
                    onClick={() => setShowStoredSecret((p) => !p)}
                  >
                    {showStoredSecret ? (
                      <EyeOff size={12} />
                    ) : (
                      <Eye size={12} />
                    )}
                  </IconBtn>
                  <IconBtn
                    title="Copy nsec"
                    onClick={() => copy(identity.nsec, "nsec")}
                  >
                    {copied === "nsec" ? (
                      <Check size={12} />
                    ) : (
                      <Copy size={12} />
                    )}
                  </IconBtn>
                </div>
              </div>
              {showStoredSecret ? (
                <div className="font-mono text-[10px] text-warn break-all">
                  {identity.nsec}
                </div>
              ) : (
                <div className="font-mono text-[10px] text-muted">
                  {"•".repeat(63)}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                type={revealNew ? "text" : "password"}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLoadKey()}
                placeholder="paste nsec1… or 64-char hex"
                className="flex-1 px-2.5 py-1.5 rounded-md bg-surface text-fg
                           placeholder:text-muted outline-none border border-transparent
                           focus:border-accent/50 text-xs font-mono"
                spellCheck={false}
                autoComplete="off"
              />
              <IconBtn
                title={revealNew ? "Hide" : "Show"}
                onClick={() => setRevealNew((p) => !p)}
              >
                {revealNew ? <EyeOff size={12} /> : <Eye size={12} />}
              </IconBtn>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleLoadKey}
                disabled={!keyInput.trim()}
                className="flex-1 px-3 py-1.5 rounded-md bg-surface hover:bg-surfaceHover
                           text-fg disabled:opacity-50 text-xs flex items-center
                           justify-center gap-1.5"
              >
                <KeyRound size={12} /> Use this key
              </button>
              <button
                onClick={handleGenerateKey}
                className="flex-1 px-3 py-1.5 rounded-md bg-surface hover:bg-surfaceHover
                           text-accent text-xs flex items-center justify-center gap-1.5"
              >
                <Sparkles size={12} /> Generate
              </button>
            </div>
            {keyError && (
              <p className="text-xs text-alert font-mono break-all">
                {keyError}
              </p>
            )}
            <p className="text-[10px] text-muted">
              Stored in OS keychain (libsecret on Linux). Dev builds use a
              separate keychain service so dev runs don&apos;t touch the
              installed app&apos;s identity.
            </p>
          </div>
        )}
      </div>

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
                    ? "load a key in Identity above first"
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

function IconBtn({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "p-1.5 rounded text-muted",
        danger ? "hover:text-alert" : "hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
