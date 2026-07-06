// User keymap: config → compiled per-map-mode tries, and the walk the reducer
// runs over them (the mapping FRONT LAYER — consulted before the built-in
// dispatch; see vimKeydown). The config is deliberately JSON-serializable:
// this type IS the future config-file schema (docs/vim-keymap-plan.md).

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

export type VimKeymapConfig = {
  /** Substituted for `<Leader>` in both LHS and RHS. Default `'\'`. */
  readonly leader?: string;
  readonly normal?: Readonly<Record<string, VimKeymapRhs>>;
  readonly visual?: Readonly<Record<string, VimKeymapRhs>>;
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
export type KeymapTrie = {
  readonly children: ReadonlyMap<string, KeymapTrie>;
  readonly binding: KeymapBinding | null;
};
export type CompiledKeymap = Readonly<Record<VimMapMode, KeymapTrie>>;

type MutableTrie = { children: Map<string, MutableTrie>; binding: KeymapBinding | null };
const emptyNode = (): MutableTrie => ({ children: new Map(), binding: null });

const MAP_MODES: readonly VimMapMode[] = ['normal', 'visual', 'operatorPending', 'insert'];

export type CompileKeymapOpts = {
  /** The action ids `{action}` RHS may reference, per map mode (the caller
   *  owns the tables — model.ts's `VIM_ACTIONS_BY_MODE`). When provided,
   *  unknown ids are compile errors. */
  readonly knownActions?: Readonly<Partial<Record<VimMapMode, ReadonlySet<string>>>>;
};

/** Compile a user keymap, or throw a descriptive error: bad notation, an
 *  empty LHS/RHS, an `{action}` where none can run, or one LHS being a
 *  strict prefix of another in the same map mode (a pure reducer cannot time
 *  out to disambiguate — conflicts are config errors, not runtime waits). */
export const compileKeymap = (config: VimKeymapConfig, opts?: CompileKeymapOpts): CompiledKeymap => {
  const leader = config.leader ?? '\\';
  const compiled = {} as Record<VimMapMode, KeymapTrie>;
  for (const mode of MAP_MODES) {
    const root = emptyNode();
    for (const [lhs, rhsSpec] of Object.entries(config[mode] ?? {})) {
      const lhsKeys = parseKeys(lhs, leader);
      if (lhsKeys.length === 0) throw new Error(`vim keymap (${mode}): empty LHS`);
      if (mode === 'insert' && lhsKeys.some((k) => k.key.length !== 1 || k.ctrl || k.alt || k.meta)) {
        throw new Error(
          `vim keymap (insert): "${lhs}" — insert LHS keys must be plain printable characters ` +
            '(the walk inserts the prefix live and deletes it on a match; chords insert nothing)',
        );
      }
      let binding: KeymapBinding;
      if (typeof rhsSpec !== 'string' && 'action' in rhsSpec) {
        if (mode === 'operatorPending' || mode === 'insert') {
          throw new Error(`vim keymap (${mode}): "${lhs}" — {action} RHS is only available in normal and visual modes`);
        }
        const known = opts?.knownActions?.[mode];
        if (known && !known.has(rhsSpec.action)) {
          throw new Error(`vim keymap (${mode}): "${lhs}" — unknown action "${rhsSpec.action}"`);
        }
        binding = { kind: 'action', action: rhsSpec.action };
      } else {
        const rhs = typeof rhsSpec === 'string' ? rhsSpec : rhsSpec.rhs;
        const remap = typeof rhsSpec === 'string' ? false : (rhsSpec.remap ?? false);
        const rhsKeys = parseKeys(rhs, leader);
        if (rhsKeys.length === 0) throw new Error(`vim keymap (${mode}): empty RHS for "${lhs}"`);
        binding = { kind: 'keys', keys: rhsKeys, remap };
      }
      let node = root;
      for (const [i, k] of lhsKeys.entries()) {
        if (node.binding) {
          throw new Error(`vim keymap (${mode}): "${lhs}" conflicts with a mapping that is its prefix`);
        }
        let child = node.children.get(keyToken(k));
        if (!child) {
          child = emptyNode();
          node.children.set(keyToken(k), child);
        }
        node = child;
        if (i === lhsKeys.length - 1) {
          if (node.binding) throw new Error(`vim keymap (${mode}): duplicate mapping "${lhs}"`);
          if (node.children.size > 0) {
            throw new Error(`vim keymap (${mode}): "${lhs}" is a prefix of another mapping`);
          }
          node.binding = binding;
        }
      }
    }
    compiled[mode] = root;
  }
  return compiled;
};

export type KeymapWalk =
  | { readonly kind: 'pending' } // a valid strict prefix — swallow and wait
  | { readonly kind: 'match'; readonly binding: KeymapBinding }
  | { readonly kind: 'miss' }; // not in the map (from the root: not ours at all)

/** Walk `keys` from the trie root (the walk is re-run per keydown — the
 *  pending state stores only the keys, never a node). */
export const walkKeymap = (trie: KeymapTrie, keys: readonly VimKey[]): KeymapWalk => {
  let node: KeymapTrie = trie;
  for (const k of keys) {
    const child = node.children.get(keyToken(k));
    if (!child) return { kind: 'miss' };
    node = child;
  }
  if (node.binding) return { kind: 'match', binding: node.binding };
  return { kind: 'pending' };
};
