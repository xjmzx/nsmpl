import { useState } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  Sparkles,
} from "lucide-react";
import { Section } from "./Section";
import {
  clearIdentity,
  generateIdentity,
  saveKey,
  type Identity,
} from "../lib/nostr";
import { cn } from "../lib/cn";

function shortNpub(npub: string): string {
  return npub.length > 28 ? `${npub.slice(0, 14)}…${npub.slice(-8)}` : npub;
}

interface IdentityPanelProps {
  identity: Identity | null;
  setIdentity: (id: Identity | null) => void;
}

export function IdentityPanel({ identity, setIdentity }: IdentityPanelProps) {
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [revealNew, setRevealNew] = useState(false);
  const [showStoredSecret, setShowStoredSecret] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* clipboard denied */
    }
  }

  async function handleLoad() {
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
  async function handleGenerate() {
    setKeyError(null);
    try {
      const id = await generateIdentity();
      setIdentity(id);
      setShowStoredSecret(true); // user needs to back this up
    } catch (e) {
      setKeyError(String(e));
    }
  }
  async function handleForget() {
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

  return (
    <Section title="Identity" icon={<KeyRound size={16} />}>
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
                onClick={handleForget}
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
            Stored in OS keychain (libsecret on Linux). Dev builds use a
            separate keychain service so dev runs don&apos;t touch the
            installed app&apos;s identity.
          </p>
        </div>
      )}
    </Section>
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
