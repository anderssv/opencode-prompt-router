// Characters that, when they precede a trailing 's', indicate the word should
// NOT have its 's' stripped. E.g. "access" (ss), "process" (ss), "fix" (xs).
const NO_STRIP_S_PRECEDING = new Set(["s", "x"]);

const STEM_SUFFIXES = ["ing", "ed", "s"] as const;
const MIN_TOKEN_LENGTH = 3;
const MIN_STEM_LENGTH = 3;

function stem(token: string): string {
  for (const suffix of STEM_SUFFIXES) {
    if (!token.endsWith(suffix)) continue;
    const stemmed = token.slice(0, -suffix.length);
    if (stemmed.length < MIN_STEM_LENGTH) continue;
    // Don't strip trailing 's' when the preceding character makes it a non-plural
    // (e.g. "access" → ss, "process" → ss, "fix" → xs)
    if (suffix === "s" && NO_STRIP_S_PRECEDING.has(stemmed[stemmed.length - 1])) continue;
    return stemmed;
  }
  return token;
}

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH)
    .map(stem);
}
