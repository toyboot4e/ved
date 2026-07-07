// Key representation and Vim key notation. The bottom of the package's import
// DAG (keys → keymap → model → extension): no imports, so both the keymap
// compiler and the reducer can share VimKey without a cycle.

/** The keydown fields the reducer reads (structural; the adapter maps a
 *  ChordEvent onto it). */
export type VimKey = {
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
};

export const plainKey = (key: string): VimKey => ({ key, ctrl: false, meta: false, alt: false, shift: false });

/** A plain printable character key: one character, no ctrl/meta/alt (shift is
 *  fine — a printable carries its own case). What insert mode types, what a
 *  search pattern accepts, and what an insert-map LHS may contain. */
export const isPlainKey = (k: VimKey): boolean => k.key.length === 1 && !k.ctrl && !k.meta && !k.alt;

/** The trie token for a key. Shift is NOT part of the token — a printable
 *  character carries its own case (`H`), and `<S-…>` specials are unsupported
 *  (v1) — so a shifted and unshifted arrival of the same character collide on
 *  purpose. */
export const keyToken = (k: VimKey): string => `${k.ctrl ? 'C-' : ''}${k.alt ? 'A-' : ''}${k.meta ? 'M-' : ''}${k.key}`;

/** `<…>` special names → the DOM `key` value the reducer sees. Names are
 *  matched case-insensitively. */
const SPECIAL_KEYS: Readonly<Record<string, string>> = {
  esc: 'Escape',
  cr: 'Enter',
  return: 'Enter',
  enter: 'Enter',
  space: ' ',
  tab: 'Tab',
  bs: 'Backspace',
  del: 'Delete',
  bar: '|',
  lt: '<',
};

/** Parse Vim key notation (`"gg"`, `"<C-l>"`, `"x<Esc>"`, `"<Leader>w"`) into
 *  the key sequence it denotes. Throws with the offending notation on any
 *  unknown `<…>` special or dangling `<`. */
export const parseKeys = (notation: string, leader = '\\'): readonly VimKey[] => {
  const keys: VimKey[] = [];
  let i = 0;
  while (i < notation.length) {
    const ch = notation[i] as string;
    if (ch !== '<') {
      keys.push(plainKey(ch));
      i++;
      continue;
    }
    const end = notation.indexOf('>', i + 1);
    if (end < 0) throw new Error(`vim keymap: dangling '<' in "${notation}" (write <lt> for a literal <)`);
    const inner = notation.slice(i + 1, end);
    i = end + 1;
    if (inner.toLowerCase() === 'leader') {
      for (const k of parseKeys(leader)) keys.push(k);
      continue;
    }
    // Modifier prefixes: <C-x>, <A-x>, <M-x>, stackable (<C-A-x>).
    let ctrl = false;
    let alt = false;
    let meta = false;
    let rest = inner;
    for (;;) {
      const m = /^([CAM])-(.+)$/i.exec(rest);
      if (!m) break;
      const mod = (m[1] as string).toLowerCase();
      if (mod === 'c') ctrl = true;
      else if (mod === 'a') alt = true;
      else meta = true;
      rest = m[2] as string;
    }
    const named = SPECIAL_KEYS[rest.toLowerCase()];
    const key = named ?? (rest.length === 1 ? rest : null);
    if (key === null) throw new Error(`vim keymap: unknown key <${inner}> in "${notation}"`);
    keys.push({ key, ctrl, alt, meta, shift: false });
  }
  return keys;
};
