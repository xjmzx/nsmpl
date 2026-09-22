// Search-key normalisation.
//
// Filenames arrive in whichever Unicode normalisation the filesystem holds.
// A name stored NFD (`Wöden` as `o` + U+0308) is a different string from the
// NFC form a keyboard produces, though they render identically — so a plain
// `includes()` finds nothing.
//
// Both sides of the comparison are folded here. The stored path is never
// normalised: a filename on Linux is a byte string with no canonical
// equivalence at the filesystem layer, and rewriting one to NFC yields a path
// that does not exist. Comparison-time only.
//
// NFC, not NFKC: this matches text the user typed against text they can see.
// Compatibility folding (µ → μ, ﬁ → fi) is a different problem — see ndisc's
// schema/identity-normalisation-design-2026-09-22.md.
export function searchKey(s: string): string {
  return s.normalize("NFC").toLowerCase();
}

/** True when `haystack` contains `needle`; pass `needle` through searchKey first. */
export function matches(haystack: string, needle: string): boolean {
  return searchKey(haystack).includes(needle);
}
