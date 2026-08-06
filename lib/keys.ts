// JIRA-style keys: a per-project prefix (projects.key), a one-letter TYPE affix,
// and a per-project number (tasks.seq / features.seq, handed out by the shared
// projects.key_seq counter). "TME-T42" is task 42; "TME-F41" is a feature. The
// affix is there so a key tells you its scope without a lookup.
//
// The counter stays shared across both types, so the number alone is still
// unique within a project — the affix reads, it doesn't identify. That's why
// parseKey accepts a bare "TME-42" too: keys written down before the affix
// existed still resolve.
//
// The rendered "TME-T42" is DERIVED at read time, never stored. Storing it would
// be a second source of truth that drifts the moment a project's key is edited,
// and repairing it would mean a backfill over every task and feature; deriving
// makes a key change instant and total. Same argument listFeatures() makes for
// not storing a feature's status.
//
// Pure functions, no DB access — createProject and migrate() both need these
// rules, and they must not be able to disagree.

const KEY_MAX = 10;

/**
 * The prefix for a project name: initials when it has words to take them from
 * ("Two Minute Empire" → TME), else the first four letters ("Alloy" → ALLO).
 * Digits are deliberately ignored when splitting — "Project 2000" is one word.
 */
export function deriveProjectKey(name: string): string {
  const words = name.split(/[^A-Za-z]+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 5).map((w) => w[0]).join("").toUpperCase();
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
  return "PRJ";
}

/**
 * deriveProjectKey, then a numeric suffix until it's free. `taken` may hold keys
 * in any case — uniqueness is case-insensitive, matching validateKey's caller.
 */
export function uniqueProjectKey(name: string, taken: Set<string>): string {
  const lower = new Set([...taken].map((k) => k.toLowerCase()));
  const base = deriveProjectKey(name);
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    // Trim the base so the suffix can't push the key past validateKey's ceiling.
    const candidate = `${base.slice(0, KEY_MAX - String(n).length)}${n}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

export const normalizeKey = (raw: string): string => raw.trim().toUpperCase();

/**
 * null = valid. Otherwise the user-facing reason, shown verbatim in the UI.
 *
 * One character is allowed on purpose: a project called "X" derives the key "X",
 * and a floor of two would make deriveProjectKey capable of producing a key its
 * own edit form rejects.
 */
export function validateKey(raw: string): string | null {
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(normalizeKey(raw)))
    return `A key is 1–${KEY_MAX} characters, letters and digits only, starting with a letter.`;
  return null;
}

/** The type affix: F for a feature, T for a task. */
export type KeyKind = "F" | "T";

/**
 * The rendered key. "" when either half is missing so every caller can render
 * nothing without a special case — a project predating the backfill, or a row
 * whose seq was never allocated, simply has no key rather than a broken one.
 */
export const displayKey = (projectKey: string, seq: number, kind: KeyKind): string =>
  projectKey && seq > 0 ? `${projectKey}-${kind}${seq}` : "";

/**
 * Split a key reference back into its parts, or null if it isn't one. Used to
 * resolve "TME-F42" against a project (see findFeature) — the prefix is checked
 * by the caller, which is the only place that knows whose key it should be.
 *
 * `kind` is null for a pre-affix "TME-42", which still resolves because the
 * number is unique across both types. An affix that is neither F nor T is not a
 * key at all — better a miss than "TME-X9" quietly resolving to number 9.
 */
export function parseKey(ref: string): { prefix: string; kind: KeyKind | null; seq: number } | null {
  const m = /^([A-Za-z][A-Za-z0-9]*)-([A-Za-z]?)(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const kind = m[2].toUpperCase();
  if (kind && kind !== "F" && kind !== "T") return null;
  const seq = Number(m[3]);
  return seq > 0 ? { prefix: m[1].toUpperCase(), kind: (kind || null) as KeyKind | null, seq } : null;
}
