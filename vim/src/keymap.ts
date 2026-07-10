/** User keymap: config → compiled per-map-mode tries, and the walk the reducer
 *  runs over them (the mapping FRONT LAYER — consulted before the built-in
 *  dispatch; see vimKeydown). The config is deliberately JSON-serializable:
 *  this type IS the future config-file schema (docs/architecture.md "Extensions"). */

import { keyToken, parseKeys, type VimKey } from './keys';

/** One RHS: a key sequence in Vim notation, or a NAMED ACTION. Plain string =
 *  noremap (the DEFAULT — fed keys go to the built-ins only); `remap: true`
 *  lets the RHS re-enter user mappings (guarded by the adapter's fed-key
 *  budget). `{action}` binds a named primitive directly (model.ts action
 *  tables; ids validated at compile when the caller provides them) — normal
 *  and visual modes only, and NOT dot-repeatable (it runs outside the key
 *  recording, like Vim's `<Plug>` targets without repeat.vim). */
export type VimKeymapRhs = string | { readonly rhs: string; readonly remap?: boolean } | { readonly action: string };

/** Vim's nmap / xmap / omap / imap. */
export type VimMapMode = 'normal' | 'visual' | 'operatorPending' | 'insert';

/** A user keymap: per-map-mode tables of LHS (Vim key notation) → RHS.
 *  JSON-serializable by design — this type IS the future config-file schema.
 *  Compile with `compileKeymap` to validate, or pass to
 *  `createVimExtension({keymap})` (which throws on errors). */
export type VimKeymapConfig = {
  /** Substituted for `<Leader>` in both LHS and RHS. Default `'\'`. */
  readonly leader?: string;
  /** Normal-mode maps (Vim's `nmap`). */
  readonly normal?: Readonly<Record<string, VimKeymapRhs>>;
  /** Visual-mode maps (Vim's `xmap`). */
  readonly visual?: Readonly<Record<string, VimKeymapRhs>>;
  /** Operator-pending maps (Vim's `omap`) — active after `d`/`c`/`y`. */
  readonly operatorPending?: Readonly<Record<string, VimKeymapRhs>>;
  /** Insert-mode maps (`jj` → `<Esc>`). LHS keys must be PLAIN printable
   *  characters (compile error otherwise): the insert walk lets the prefix
   *  INSERT LIVE and deletes it on a match — chords insert nothing, so they
   *  cannot participate. See model.ts insertMappingKey. */
  readonly insert?: Readonly<Record<string, VimKeymapRhs>>;
};

export type KeymapBinding =
  | { readonly kind: 'keys'; readonly keys: readonly VimKey[]; readonly remap: boolean }
  | { readonly kind: 'action'; readonly action: string };

/** A generic token trie — ONE implementation walked by both the user keymap
 *  layer and model.ts's built-in sequences (`gg`, text objects). */
export type Trie<T> = { readonly children: ReadonlyMap<string, Trie<T>>; readonly value: T | null };

export type KeymapTrie = Trie<KeymapBinding>;
export type CompiledKeymap = Readonly<Record<VimMapMode, KeymapTrie>>;

type MutableTrie<T> = { children: Map<string, MutableTrie<T>>; value: T | null };
const emptyNode = <T>(): MutableTrie<T> => ({ children: new Map(), value: null });

/** Build a trie from token-sequence entries. No conflict checking — a later
 *  entry overwrites (compileKeymap validates conflicts itself, where it can
 *  name the offending LHS). */
export const buildTrie = <T>(entries: Iterable<readonly [readonly string[], T]>): Trie<T> => {
  const root = emptyNode<T>();
  for (const [tokens, value] of entries) {
    let node = root;
    for (const t of tokens) {
      let child = node.children.get(t);
      if (!child) {
        child = emptyNode<T>();
        node.children.set(t, child);
      }
      node = child;
    }
    node.value = value;
  }
  return root;
};

export type TrieWalk<T> =
  | { readonly kind: 'pending' } // a valid strict prefix — swallow and wait
  | { readonly kind: 'match'; readonly value: T }
  | { readonly kind: 'miss' }; // not in the trie (from the root: not ours at all)

/** Walk `tokens` from the trie root (the walk is re-run per keydown — the
 *  pending state stores only the keys, never a node). */
export const walkTrie = <T>(root: Trie<T>, tokens: readonly string[]): TrieWalk<T> => {
  let node: Trie<T> = root;
  for (const t of tokens) {
    const child = node.children.get(t);
    if (!child) return { kind: 'miss' };
    node = child;
  }
  if (node.value !== null) return { kind: 'match', value: node.value };
  return { kind: 'pending' };
};

const MAP_MODES: readonly VimMapMode[] = ['normal', 'visual', 'operatorPending', 'insert'];

export type CompileKeymapOpts = {
  /** The action ids `{action}` RHS may reference, per map mode (the caller
   *  owns the tables — model.ts's `VIM_ACTIONS_BY_MODE`). When provided,
   *  unknown ids are compile errors. */
  readonly knownActions?: Readonly<Partial<Record<VimMapMode, ReadonlySet<string>>>>;
};

/** Parse + validate one LHS: non-empty, and (insert mode) plain printable
 *  characters only — the insert walk inserts the prefix live and deletes it
 *  on a match, so chords cannot participate. */
const parseLhs = (mode: VimMapMode, lhs: string, leader: string): readonly VimKey[] => {
  const lhsKeys = parseKeys(lhs, leader);
  if (lhsKeys.length === 0) throw new Error(`vim keymap (${mode}): empty LHS`);
  if (mode === 'insert' && lhsKeys.some((k) => k.key.length !== 1 || k.ctrl || k.alt || k.meta)) {
    throw new Error(
      `vim keymap (insert): "${lhs}" — insert LHS keys must be plain printable characters ` +
        '(the walk inserts the prefix live and deletes it on a match; chords insert nothing)',
    );
  }
  return lhsKeys;
};

/** Compile one `{action}` RHS: normal/visual only, and (when the caller
 *  provided the tables) a known action id. */
const compileActionBinding = (
  mode: VimMapMode,
  lhs: string,
  action: string,
  opts?: CompileKeymapOpts,
): KeymapBinding => {
  if (mode === 'operatorPending' || mode === 'insert') {
    throw new Error(`vim keymap (${mode}): "${lhs}" — {action} RHS is only available in normal and visual modes`);
  }
  const known = opts?.knownActions?.[mode];
  if (known && !known.has(action)) {
    throw new Error(`vim keymap (${mode}): "${lhs}" — unknown action "${action}"`);
  }
  return { kind: 'action', action };
};

/** Compile one RHS spec — a named action or a (possibly remap) key sequence —
 *  into its binding. */
const compileBinding = (
  mode: VimMapMode,
  lhs: string,
  rhsSpec: VimKeymapRhs,
  leader: string,
  opts?: CompileKeymapOpts,
): KeymapBinding => {
  if (typeof rhsSpec !== 'string' && 'action' in rhsSpec) {
    return compileActionBinding(mode, lhs, rhsSpec.action, opts);
  }
  const rhs = typeof rhsSpec === 'string' ? rhsSpec : rhsSpec.rhs;
  const remap = typeof rhsSpec === 'string' ? false : (rhsSpec.remap ?? false);
  const rhsKeys = parseKeys(rhs, leader);
  if (rhsKeys.length === 0) throw new Error(`vim keymap (${mode}): empty RHS for "${lhs}"`);
  return { kind: 'keys', keys: rhsKeys, remap };
};

/** Insert one compiled mapping into the mode's trie, rejecting the prefix
 *  conflicts a pure reducer cannot disambiguate (no timeouts): an LHS that
 *  extends, duplicates, or is a prefix of another mapping. */
const insertMapping = (
  root: MutableTrie<KeymapBinding>,
  mode: VimMapMode,
  lhs: string,
  lhsKeys: readonly VimKey[],
  binding: KeymapBinding,
): void => {
  let node = root;
  for (const [i, k] of lhsKeys.entries()) {
    if (node.value) {
      throw new Error(`vim keymap (${mode}): "${lhs}" conflicts with a mapping that is its prefix`);
    }
    let child = node.children.get(keyToken(k));
    if (!child) {
      child = emptyNode();
      node.children.set(keyToken(k), child);
    }
    node = child;
    if (i === lhsKeys.length - 1) {
      if (node.value) throw new Error(`vim keymap (${mode}): duplicate mapping "${lhs}"`);
      if (node.children.size > 0) {
        throw new Error(`vim keymap (${mode}): "${lhs}" is a prefix of another mapping`);
      }
      node.value = binding;
    }
  }
};

/** Compile a user keymap, or throw a descriptive error: bad notation, an
 *  empty LHS/RHS, an `{action}` where none can run, or one LHS being a
 *  strict prefix of another in the same map mode (a pure reducer cannot time
 *  out to disambiguate — conflicts are config errors, not runtime waits). */
export const compileKeymap = (config: VimKeymapConfig, opts?: CompileKeymapOpts): CompiledKeymap => {
  const leader = config.leader ?? '\\';
  const compiled = {} as Record<VimMapMode, KeymapTrie>;
  for (const mode of MAP_MODES) {
    const root = emptyNode<KeymapBinding>();
    for (const [lhs, rhsSpec] of Object.entries(config[mode] ?? {})) {
      const lhsKeys = parseLhs(mode, lhs, leader);
      insertMapping(root, mode, lhs, lhsKeys, compileBinding(mode, lhs, rhsSpec, leader, opts));
    }
    compiled[mode] = root;
  }
  return compiled;
};

export type KeymapWalk =
  | { readonly kind: 'pending' } // a valid strict prefix — swallow and wait
  | { readonly kind: 'match'; readonly binding: KeymapBinding }
  | { readonly kind: 'miss' }; // not in the map (from the root: not ours at all)

/** Walk `keys` from the trie root — walkTrie over key tokens, the match
 *  spelled as a `binding`. */
export const walkKeymap = (trie: KeymapTrie, keys: readonly VimKey[]): KeymapWalk => {
  const walk = walkTrie(
    trie,
    keys.map((k) => keyToken(k)),
  );
  return walk.kind === 'match' ? { kind: 'match', binding: walk.value } : walk;
};
