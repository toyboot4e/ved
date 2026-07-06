// User keymap: config → compiled per-map-mode tries, and the walk the reducer
// runs over them (the mapping FRONT LAYER — consulted before the built-in
// dispatch; see vimKeydown). The config is deliberately JSON-serializable:
// this type IS the future config-file schema (docs/vim-keymap-plan.md).

import { keyToken, parseKeys, type VimKey } from './keys';

/** One RHS: a key sequence in Vim notation. Plain string = noremap (the
 *  DEFAULT — fed keys go to the built-ins only); `remap: true` lets the RHS
 *  re-enter user mappings (guarded by the adapter's fed-key budget). */
export type VimKeymapRhs = string | { readonly rhs: string; readonly remap?: boolean };

/** Vim's nmap / xmap / omap. imap is deferred (IME interaction — see plan). */
export type VimMapMode = 'normal' | 'visual' | 'operatorPending';

export type VimKeymapConfig = {
  /** Substituted for `<Leader>` in both LHS and RHS. Default `'\'`. */
  readonly leader?: string;
  readonly normal?: Readonly<Record<string, VimKeymapRhs>>;
  readonly visual?: Readonly<Record<string, VimKeymapRhs>>;
  readonly operatorPending?: Readonly<Record<string, VimKeymapRhs>>;
};

export type KeymapBinding = { readonly keys: readonly VimKey[]; readonly remap: boolean };
export type KeymapTrie = {
  readonly children: ReadonlyMap<string, KeymapTrie>;
  readonly binding: KeymapBinding | null;
};
export type CompiledKeymap = Readonly<Record<VimMapMode, KeymapTrie>>;

type MutableTrie = { children: Map<string, MutableTrie>; binding: KeymapBinding | null };
const emptyNode = (): MutableTrie => ({ children: new Map(), binding: null });

const MAP_MODES: readonly VimMapMode[] = ['normal', 'visual', 'operatorPending'];

/** Compile a user keymap, or throw a descriptive error: bad notation, an
 *  empty LHS/RHS, or one LHS being a strict prefix of another in the same
 *  map mode (a pure reducer cannot time out to disambiguate — conflicts are
 *  config errors, not runtime waits). */
export const compileKeymap = (config: VimKeymapConfig): CompiledKeymap => {
  const leader = config.leader ?? '\\';
  const compiled = {} as Record<VimMapMode, KeymapTrie>;
  for (const mode of MAP_MODES) {
    const root = emptyNode();
    for (const [lhs, rhsSpec] of Object.entries(config[mode] ?? {})) {
      const rhs = typeof rhsSpec === 'string' ? rhsSpec : rhsSpec.rhs;
      const remap = typeof rhsSpec === 'string' ? false : (rhsSpec.remap ?? false);
      const lhsKeys = parseKeys(lhs, leader);
      const rhsKeys = parseKeys(rhs, leader);
      if (lhsKeys.length === 0) throw new Error(`vim keymap (${mode}): empty LHS`);
      if (rhsKeys.length === 0) throw new Error(`vim keymap (${mode}): empty RHS for "${lhs}"`);
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
          node.binding = { keys: rhsKeys, remap };
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
