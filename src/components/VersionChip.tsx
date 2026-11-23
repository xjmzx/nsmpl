import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Loader2, RotateCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "../lib/cn";
import { TickBox } from "./TickBox";
import {
  APP_REPO,
  RECHECK_MS,
  cacheIsFresh,
  compareSemver,
  fetchLatest,
  loadCache,
  loadEnabled,
  saveEnabled,
  type LatestRelease,
} from "../lib/updateCheck";

// The n-suite version chip (SUITE.md § top-bar grammar + Version format).
// Shows major.minor.patch only; the full version sits in the tooltip.
// Clicking opens a small popover: update status, a link to the newer release
// when there is one, "Check now", and the on/off switch for the daily check.
// A newer release puts a dot on the chip's corner — positioned absolutely so
// the chip keeps its fixed width.

const FIRST_CHECK_DELAY_MS = 10_000;

// Dev builds don't check on their own (dev/install isolation). Set
// VITE_UPDATE_TEST_VERSION=0.0.1 in a dev run to exercise the dot and link;
// "Check now" works in dev regardless.
const TEST_VERSION = import.meta.env.DEV
  ? (import.meta.env.VITE_UPDATE_TEST_VERSION as string | undefined)
  : undefined;

function shortVersion(v: string): string {
  return v.split(/[-+]/)[0];
}

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; latest: LatestRelease | null; checkedAt: number }
  | { kind: "error"; message: string };

export function VersionChip({ version }: { version: string }) {
  const current = TEST_VERSION ?? version;
  const [enabled, setEnabledState] = useState(loadEnabled);
  const [state, setState] = useState<State>(() => {
    const c = loadCache();
    return c ? { kind: "done", latest: c.latest, checkedAt: c.checkedAt } : { kind: "idle" };
  });
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const check = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const c = await fetchLatest();
      setState({ kind: "done", latest: c.latest, checkedAt: c.checkedAt });
    } catch (e) {
      setState({ kind: "error", message: String(e instanceof Error ? e.message : e) });
    }
  }, []);

  // Automatic check: ~10 s after launch unless the cached answer is under a
  // day old, then once a day while the app stays open.
  useEffect(() => {
    if (!enabled || (import.meta.env.DEV && !TEST_VERSION)) return;
    const first = window.setTimeout(
      () => {
        if (!cacheIsFresh(loadCache())) void check();
      },
      FIRST_CHECK_DELAY_MS,
    );
    const every = window.setInterval(() => void check(), RECHECK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [enabled, check]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const latest = state.kind === "done" ? state.latest : null;
  // The popover always tells the truth about the last answer; the dot only
  // shows while the daily check is on.
  const newer = latest && compareSemver(latest.version, current) > 0 ? latest : null;
  const dot = enabled && newer;

  const setEnabled = (on: boolean) => {
    saveEnabled(on);
    setEnabledState(on);
  };

  let status: ReactNode;
  if (state.kind === "checking") {
    status = (
      <span className="inline-flex items-center gap-1.5">
        <Loader2 size={11} className="animate-spin" /> Checking…
      </span>
    );
  } else if (state.kind === "error") {
    status = <span className="text-warn">Couldn't check: {state.message}</span>;
  } else if (state.kind === "done") {
    status = newer ? (
      <span className="text-fg">v{newer.version} is available</span>
    ) : latest ? (
      <span>Up to date — latest release is v{latest.version}</span>
    ) : (
      <span>No releases published yet</span>
    );
  } else {
    status = <span>Not checked yet</span>;
  }

  return (
    <div ref={wrapRef} className="relative hidden md:inline-flex shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={dot ? `v${current} · v${dot.version} available` : `v${current}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative inline-flex items-center px-2.5 py-2 rounded-md
                   bg-surface text-mauve font-mono text-xs cursor-pointer
                   transition-colors hover:bg-surfaceHover"
      >
        v{shortVersion(current)}
        {dot && (
          <span
            aria-label="Update available"
            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-ok
                       ring-2 ring-panel"
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Version and updates"
          className="absolute left-0 top-full mt-2 z-40 w-72 rounded-lg border
                     border-surface/70 bg-panel shadow-xl p-3 text-[11px] text-muted
                     space-y-2.5"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-xs text-mauve">v{current}</span>
            <span className="truncate">{APP_REPO}</span>
          </div>

          <p className="leading-snug">{status}</p>

          {newer && (
            <button
              type="button"
              onClick={() => void openUrl(newer.url)}
              className="w-full inline-flex items-center justify-center gap-1.5
                         rounded-md bg-ok/15 border border-ok/40 text-ok px-2 py-1.5
                         text-xs hover:bg-ok/25 transition-colors"
            >
              <ExternalLink size={12} /> Open the v{newer.version} release
            </button>
          )}

          <div className="flex items-center justify-between gap-2 pt-1 border-t border-surface/70">
            <label className="inline-flex items-center gap-2 cursor-pointer pt-2">
              <TickBox
                checked={enabled}
                onChange={setEnabled}
                ariaLabel="Check GitHub for new releases daily"
              />
              <span>Check daily</span>
            </label>
            <button
              type="button"
              onClick={() => void check()}
              disabled={state.kind === "checking"}
              className={cn(
                "inline-flex items-center gap-1 pt-2 hover:text-fg transition-colors",
                state.kind === "checking" && "opacity-50 cursor-default",
              )}
            >
              <RotateCw size={11} /> Check now
            </button>
          </div>
          <p className="text-[10px] leading-snug">
            Asks GitHub for the latest release; nothing is downloaded. GitHub
            sees this computer's address when it checks.
          </p>
        </div>
      )}
    </div>
  );
}
