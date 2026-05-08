import { useState } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  LogOut,
  Sparkles,
} from "lucide-react";
import { Section } from "./Section";
import type { AudioFile, AudioInfo } from "../lib/tauri";
import {
  clearIdentity,
  generateIdentity,
  saveKey,
  type Identity,
} from "../lib/nostr";
import { cn } from "../lib/cn";

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

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtDate(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function fmtDuration(s: number): string {
  if (!isFinite(s) || s <= 0) return "—";
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

function shortNpub(npub: string): string {
  return npub.length > 28 ? `${npub.slice(0, 14)}…${npub.slice(-8)}` : npub;
}

interface InfoPanelProps {
  identity: Identity | null;
  setIdentity: (id: Identity | null) => void;
  file: AudioFile | null;
  audioInfo: AudioInfo | null;
}

export function InfoPanel({
  identity,
  setIdentity,
  file,
  audioInfo,
}: InfoPanelProps) {
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [revealNew, setRevealNew] = useState(false);
  const [showStoredSecret, setShowStoredSecret] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  function handleLoad() {
    setKeyError(null);
    try {
      const id = saveKey(keyInput);
      setIdentity(id);
      setKeyInput("");
      setRevealNew(false);
      setShowStoredSecret(false);
    } catch (e) {
      setKeyError(String(e));
    }
  }
  function handleGenerate() {
    setKeyError(null);
    const id = generateIdentity();
    setIdentity(id);
    setShowStoredSecret(true); // user needs to back this up
  }
  function handleLogout() {
    if (
      !confirm(
        "Forget this nsec from local storage? Make sure you've backed it up.",
      )
    ) {
      return;
    }
    clearIdentity();
    setIdentity(null);
    setShowStoredSecret(false);
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

  const mime = file ? mimeFor(file.name) : null;

  return (
    <Section title="Identity & sample info" icon={<Info size={16} />} className="h-full">
      {/* ---------- Identity ---------- */}
      <Subheader>Identity</Subheader>
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
                {copied === "npub" ? <Check size={12} /> : <Copy size={12} />}
              </IconBtn>
              <IconBtn
                title="Forget this key"
                onClick={handleLogout}
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
                  {showStoredSecret ? <EyeOff size={12} /> : <Eye size={12} />}
                </IconBtn>
                <IconBtn
                  title="Copy nsec"
                  onClick={() => copy(identity.nsec, "nsec")}
                >
                  {copied === "nsec" ? <Check size={12} /> : <Copy size={12} />}
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
              onKeyDown={(e) => e.key === "Enter" && handleLoad()}
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
              onClick={handleLoad}
              disabled={!keyInput.trim()}
              className="flex-1 px-3 py-1.5 rounded-md bg-surface hover:bg-surfaceHover
                         text-fg disabled:opacity-50 text-xs flex items-center
                         justify-center gap-1.5"
            >
              <KeyRound size={12} /> Use this key
            </button>
            <button
              onClick={handleGenerate}
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
            Stored in localStorage. Replace with OS keyring before shipping.
          </p>
        </div>
      )}

      {/* ---------- Sample info ---------- */}
      <Subheader>Sample info</Subheader>
      {!file ? (
        <p className="text-xs text-muted">Select a sample on the left.</p>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          <Row label="name" value={file.name} mono />
          <Row label="path" value={file.path} mono truncate />
          <Row label="size" value={fmtSize(file.size)} />
          <Row label="modified" value={fmtDate(file.modified)} />
          <Row label="mime" value={mime ?? "—"} mono />
          {audioInfo ? (
            <>
              <Row
                label="rate"
                value={`${(audioInfo.sampleRate / 1000).toFixed(1)} kHz`}
              />
              <Row
                label="channels"
                value={
                  audioInfo.channels === 1
                    ? "mono"
                    : audioInfo.channels === 2
                      ? "stereo"
                      : `${audioInfo.channels}-ch`
                }
              />
              <Row label="duration" value={fmtDuration(audioInfo.duration)} />
            </>
          ) : (
            <Row label="audio" value="decoding…" muted />
          )}
        </dl>
      )}

      {/* ---------- NIP preview ---------- */}
      <Subheader>Will publish as</Subheader>
      <div className="rounded-md bg-bg/50 p-2 text-[10px] font-mono space-y-0.5">
        <div className="text-muted">
          <span className="text-accent">kind 1063</span>{" "}
          <span className="text-fg/70">
            (NIP-94 — file metadata)
          </span>
        </div>
        <div className="pl-2 text-fg/80">
          <span className="text-muted">tags:</span>
        </div>
        <TagPreview k="url" v="<set on upload>" />
        <TagPreview k="m" v={mime ?? "<extension-derived>"} />
        <TagPreview k="x" v="<sha256 hex>" />
        <TagPreview
          k="size"
          v={file ? `${file.size}` : "<bytes>"}
        />
        <TagPreview k="title" v="<from publish form>" />
        <div className="pt-1 text-muted text-[9px]">
          Auth: NIP-98 (HTTP Auth, kind 27235). Upload: NIP-96.
        </div>
      </div>
    </Section>
  );
}

function Subheader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wide text-muted mt-2 mb-1.5">
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  truncate,
  muted,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
  muted?: boolean;
}) {
  return (
    <>
      <dt className="text-muted text-[10px] uppercase tracking-wide">
        {label}
      </dt>
      <dd
        className={cn(
          mono && "font-mono",
          truncate && "truncate",
          muted ? "text-muted italic" : "text-fg/90",
        )}
        title={value}
      >
        {value}
      </dd>
    </>
  );
}

function TagPreview({ k, v }: { k: string; v: string }) {
  return (
    <div className="pl-2 flex gap-2">
      <span className="text-accent shrink-0">{k}</span>
      <span className="text-fg/70 truncate">{v}</span>
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
