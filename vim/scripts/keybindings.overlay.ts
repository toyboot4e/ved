// Schema + decoder for keybindings.overlay.json — the hand-curated overlay for
// the keybinding reference, the MANUAL half of the generator's inputs (the
// mechanical halves are Vim's index.txt and our VIM_BINDINGS catalog).
//
// The JSON is an ordered list of curation groups (`about` + `entries`): the
// out-of-scope families first, then the staged worklist of scope-'core'
// bindings with their intended @ved/vim surface (docs/keybindings.md renders
// it in the API column). Entries are keyed by Vim help TAG (the stable id in
// index.txt, e.g. `dd`, `CTRL-R`, `v_iw`). Every field is optional:
//
//   scope    'core'  — a binding we intend to support (default for matched
//                       rows; unmatched rows we might still do → a TODO).
//            'out'   — out of ved's scope (windows, folds, tags, quickfix,
//                       ex-mode plumbing); rendered under a collapsed section.
//   category overrides the auto-derived group heading.
//   api      the intended @ved/vim TypeScript surface for a NOT-yet-built
//            binding — the definition we would add. Free text (a MotionId, an
//            action id, or a signature sketch). Implemented rows read their
//            real id from the catalog instead.
//   note     any caveat to show in the reference.

export type OverlayEntry = {
  readonly scope?: 'core' | 'out';
  readonly category?: string;
  readonly api?: string;
  readonly note?: string;
};

/** The overlay flattened for the join: Vim help tag → curation. */
export type Overlay = Readonly<Record<string, OverlayEntry>>;

const ENTRY_KEYS = new Set(['scope', 'category', 'api', 'note']);

const fail = (msg: string): never => {
  throw new Error(`keybindings.overlay.json: ${msg}`);
};

const parseEntry = (tag: string, raw: unknown): OverlayEntry => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(`entry '${tag}' must be an object`);
  const rec = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(rec)) {
    if (!ENTRY_KEYS.has(key)) fail(`entry '${tag}' has unknown field '${key}'`);
    if (typeof value !== 'string') fail(`entry '${tag}' field '${key}' must be a string`);
  }
  if ('scope' in rec && rec.scope !== 'core' && rec.scope !== 'out') {
    fail(`entry '${tag}' scope must be 'core' or 'out'`);
  }
  return rec as OverlayEntry;
};

const parseGroup = (group: unknown): ReadonlyArray<readonly [string, OverlayEntry]> => {
  if (typeof group !== 'object' || group === null) fail('each group must be an object');
  const { about, entries, ...rest } = group as Record<string, unknown>;
  if (typeof about !== 'string') fail("each group needs an 'about' string");
  if (Object.keys(rest).length > 0) fail(`group '${about}' has unknown fields: ${Object.keys(rest).join(', ')}`);
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    fail(`group '${about}' needs an 'entries' record`);
  }
  return Object.entries(entries as Record<string, unknown>).map(([tag, entry]) => [tag, parseEntry(tag, entry)]);
};

/** Decode the parsed JSON (validating shape — the type checker no longer sees
 *  the data) and flatten the groups into one tag-keyed record. */
export const parseOverlay = (raw: unknown): Overlay => {
  if (!Array.isArray(raw)) fail('expected an array of groups');
  const flat: Record<string, OverlayEntry> = {};
  for (const group of raw as unknown[]) {
    for (const [tag, entry] of parseGroup(group)) {
      if (tag in flat) fail(`duplicate tag '${tag}'`);
      flat[tag] = entry;
    }
  }
  return flat;
};
