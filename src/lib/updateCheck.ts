// n-suite update check (notify-only). Vendored per app like shortVersion;
// only APP_REPO differs between apps. See SUITE.md § Version format.
//
// Asks GitHub for the repo's latest *published, non-pre-release* release and
// compares it with this build's version. Nothing is downloaded or installed:
// the version chip shows a dot and links out to the release page.
//
// Privacy: each check tells GitHub this machine's IP and which app asked. The
// check can be switched off from the chip's popover; the choice is kept in
// localStorage. A fresh result is cached for a day so restarts don't re-ask.

export const APP_REPO = "xjmzx/nsmpl";

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const ENABLED_KEY = "updateCheck.enabled";
const CACHE_KEY = "updateCheck.cache";

export type LatestRelease = {
  version: string; // tag without the leading "v"
  url: string; // the release's html page
  publishedAt: string | null;
};

type Cache = { repo: string; checkedAt: number; latest: LatestRelease | null };

export function loadEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "true" : "false");
  } catch {
    /* storage unavailable — the choice lasts this session only */
  }
}

export function loadCache(): Cache | null {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as Cache | null;
    return c && c.repo === APP_REPO && typeof c.checkedAt === "number" ? c : null;
  } catch {
    return null;
  }
}

function saveCache(latest: LatestRelease | null): Cache {
  const c: Cache = { repo: APP_REPO, checkedAt: Date.now(), latest };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
  return c;
}

export function cacheIsFresh(c: Cache | null): boolean {
  return !!c && Date.now() - c.checkedAt < CHECK_EVERY_MS;
}

export const RECHECK_MS = CHECK_EVERY_MS;

// GET /releases/latest skips drafts and pre-releases (the release workflow
// marks any hyphenated tag a pre-release), so a beta tag never prompts.
// A repo with no releases answers 404 → null, not an error.
export async function fetchLatest(): Promise<Cache> {
  const res = await fetch(`https://api.github.com/repos/${APP_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return saveCache(null);
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const j = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    published_at?: string | null;
  };
  if (!j.tag_name || !j.html_url) throw new Error("unexpected release payload");
  return saveCache({
    version: j.tag_name.replace(/^v/, ""),
    url: j.html_url,
    publishedAt: j.published_at ?? null,
  });
}

// Semver precedence: major.minor.patch numerically, then a version WITH a
// pre-release suffix sorts below the same version without one
// (0.9.2-beta.1 < 0.9.2), and pre-release identifiers compare dot by dot,
// numeric ones numerically. Build metadata (+…) is ignored.
export function compareSemver(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("+")[0].split(/-(.*)/s);
    const nums = core.split(".").map((n) => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre ? pre.split(".") : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) {
    return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (+p !== +q) return +p < +q ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}
