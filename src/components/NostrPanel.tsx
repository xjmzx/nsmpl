import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Radio,
  Sparkles,
  Upload,
} from "lucide-react";
import { Section } from "./Section";
import { readAudioFile, type AudioFile } from "../lib/tauri";
import {
  DEFAULT_NIP96_ENDPOINT,
  generateIdentity,
  publishFileMetadata,
  saveKey,
  uploadToNip96,
  type Identity,
  type PublishResult,
} from "../lib/nostr";
import { cn } from "../lib/cn";

// damus rate-limits batch publish — kept out of the seed list. Use
// fizx.uk + nos.lol + primal as the default trio.
const DEFAULT_RELAYS = [
  "wss://relay.fizx.uk",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

const EXPANDED_KEY = "smpl-tool.nostr.expanded";
const RELAYS_KEY = "smpl-tool.relays";

function loadRelays(): string[] {
  try {
    const raw = localStorage.getItem(RELAYS_KEY);
    if (!raw) return DEFAULT_RELAYS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      return parsed;
    }
  } catch {
    /* fallthrough */
  }
  return DEFAULT_RELAYS;
}

function endpointHost(url: string): string {
  return url.replace(/^https?:\/\//i, "").split("/")[0] ?? url;
}

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
  // Surfaced from App's loadIdentity catch — shown in the logged-out
  // view so a keychain read failure is visible instead of silently
  // landing the user on a paste-nsec screen with no clue why.
  identityLoadError?: string | null;
}

export function NostrPanel({
  file,
  identity,
  setIdentity,
  identityLoadError,
}: NostrPanelProps) {
  const [expanded, setExpanded] = useState(
    () => localStorage.getItem(EXPANDED_KEY) === "1",
  );
  useEffect(() => {
    localStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0");
  }, [expanded]);

  const [relays, setRelays] = useState<string[]>(loadRelays);
  useEffect(() => {
    localStorage.setItem(RELAYS_KEY, JSON.stringify(relays));
  }, [relays]);

  // Logged-out identity loader (only used when no identity yet).
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [revealNew, setRevealNew] = useState(false);

  async function handleLoadKey() {
    setKeyError(null);
    try {
      const id = await saveKey(keyInput);
      setIdentity(id);
      setKeyInput("");
      setRevealNew(false);
    } catch (e) {
      setKeyError(String(e));
    }
  }
  async function handleGenerateKey() {
    setKeyError(null);
    try {
      const id = await generateIdentity();
      setIdentity(id);
    } catch (e) {
      setKeyError(String(e));
    }
  }
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

  // Inline status caption shown next to the icon-only Publish button.
  const statusText =
    status.kind === "reading"
      ? "reading file…"
      : status.kind === "uploading"
        ? "uploading…"
        : status.kind === "publishing"
          ? "publishing…"
          : status.kind === "ok"
            ? "published"
            : status.kind === "err"
              ? "failed — try again"
              : !identity
                ? "load a key in the Identity panel first"
                : !file
                  ? "select a sample"
                  : "Publish to Nostr";

  const collapsedSummary = `relays: ${relays.length} · ${endpointHost(endpoint)}`;
  // Section icon swaps to KeyRound when logged out — the panel
  // doubles as the sign-in surface, so a key icon flags "your
  // identity lives here". Switches to the broadcast Radio glyph
  // once you're signed in and publishing is the panel's job.
  const sectionIcon = identity ? (
    <Radio size={16} />
  ) : (
    <KeyRound size={16} />
  );

  const sectionTitle = "Publish";
  const toggleExpanded = () => setExpanded((p) => !p);

  if (!expanded) {
    return (
      <Section
        title={sectionTitle}
        icon={sectionIcon}
        onTitleClick={toggleExpanded}
        className="border-auburn/30 min-h-[5rem]"
      >
        <p
          className="text-xs text-accent truncate font-mono"
          title={collapsedSummary}
        >
          {collapsedSummary}
        </p>
      </Section>
    );
  }

  // Logged-out view: just the identity loader. Identity management
  // for already-signed-in flows lives in the header KeyRound chip
  // (forget) — no inline identity block when signed in.
  if (!identity) {
    return (
      <Section
        title={sectionTitle}
        icon={sectionIcon}
        onTitleClick={toggleExpanded}
        className="border-auburn/30"
      >
        {identityLoadError && (
          <p className="text-xs text-alert font-mono break-all bg-alert/10 px-2 py-1.5 rounded">
            keychain read failed on startup: {identityLoadError}
          </p>
        )}
        <p className="text-xs text-muted">
          ndisc.smpl signs publishes with a Nostr keypair. Generate a new
          identity or paste an existing nsec — your secret key is stored
          in the OS keychain (libsecret on Linux), never in plain files.
        </p>
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
          <button
            type="button"
            onClick={() => setRevealNew((p) => !p)}
            title={revealNew ? "Hide" : "Show"}
            className="p-1.5 rounded text-muted hover:text-fg"
          >
            {revealNew ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
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
          <p className="text-xs text-alert font-mono break-all">{keyError}</p>
        )}
        <p className="text-[10px] text-muted">
          Dev builds use a separate keychain service so <code>make dev</code>
          {" "}runs don&apos;t touch the installed app&apos;s identity. Use the
          KeyRound chip in the header to forget the key.
        </p>
      </Section>
    );
  }

  return (
    <Section
      title={sectionTitle}
      icon={sectionIcon}
      onTitleClick={toggleExpanded}
      className="border-auburn/30"
    >
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
      <div className="mt-3">
        <div className="text-[10px] uppercase tracking-wide text-muted mb-1">
          NIP-96 server
        </div>
        {/* Same flex layout as the relay-add row so the input width
            matches the relay-input width exactly (invisible "Add"
            placeholder reserves the same trailing slot). */}
        <div className="flex gap-2">
          <input
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            className="flex-1 px-3 py-1.5 rounded-md bg-surface text-fg
                       placeholder:text-muted outline-none border border-transparent
                       focus:border-accent/50 text-xs font-mono"
            spellCheck={false}
          />
          <span
            aria-hidden="true"
            className="invisible px-3 py-1.5 text-xs"
          >
            Add
          </span>
        </div>
      </div>

      {/* ---- Title + Publish (right-slot of the Title row replaces
              the invisible-Add placeholder so the Publish button
              sits in the same column as the Add button above). ---- */}
      <div className="mt-3">
        <div className="text-[10px] uppercase tracking-wide text-muted mb-1">
          Title
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={file ? file.name : "select a sample first"}
            disabled={!file}
            className="flex-1 px-3 py-1.5 rounded-md bg-surface text-fg
                       placeholder:text-muted outline-none border border-transparent
                       focus:border-accent/50 text-xs disabled:opacity-50"
          />
          <button
            onClick={handlePublish}
            disabled={!identity || !file || busy}
            title={statusText}
            aria-label="Publish to Nostr"
            className={cn(
              // Square, height matched to the other inputs/buttons
              // in the panel (px-3 py-1.5 text-xs ⇒ ~28px tall).
              "h-7 aspect-square rounded-md font-semibold shrink-0",
              "flex items-center justify-center",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              status.kind === "ok"
                ? "bg-ok/20 text-ok"
                : status.kind === "err"
                  ? "bg-alert/20 text-alert"
                  : "bg-accent text-bg hover:opacity-90",
            )}
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Upload size={14} />
            )}
          </button>
        </div>
      </div>

      {/* Caption only when there's actually something to say.
          The idle "Publish to Nostr" copy is suppressed — the
          button + tooltip carry that meaning. */}
      {statusText !== "Publish to Nostr" && (
        <p
          className={cn(
            "mt-2 text-xs min-w-0 truncate",
            status.kind === "ok"
              ? "text-ok"
              : status.kind === "err"
                ? "text-alert"
                : busy
                  ? "text-fg"
                  : "text-muted",
          )}
          title={statusText}
        >
          {statusText}
        </p>
      )}

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

