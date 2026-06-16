// Selection → DOM-class mapping for the Lexical editor. The class names this
// listener flips on/off are the contract between three callers:
//
//   .activePara       on the paragraph holding the caret.
//   .rubyActive       on the ruby holding the caret, when the caret is
//                     INSIDE the rubied text (a body/rt leaf — not a
//                     boundary delim). The highlight is the visual cue
//                     that distinguishes the two model positions at a
//                     ruby boundary, which sit on the same pixel.
//   .rubyLeadActive   on a ruby whose LEADING boundary holds the caret AND
//                     the ruby starts the paragraph. CSS uses this to hide
//                     the native caret (which Chromium would render at the
//                     small-font delim's metrics) and draw an absolutely-
//                     positioned 1em overlay caret at the column edge.
//   .rubyTrailActive  symmetric for the TRAILING boundary of a last-child
//                     ruby.
//
// Selection-driven only; no tree mutation, so it never interferes with IME
// or structure repair.
import { $getSelection, $isRangeSelection, type LexicalEditor, type LexicalNode, type PointType } from 'lexical';
import { $isRubyNode, DelimNode, type RubyNode } from './nodes';
import styles from './ruby.module.scss';

export type AppearKeys = {
  paraKey: string | null;
  rubyKey: string | null;
  rubyLeadKey: string | null;
  rubyTrailKey: string | null;
};

const EMPTY: AppearKeys = { paraKey: null, rubyKey: null, rubyLeadKey: null, rubyTrailKey: null };

/** Where the caret sits relative to a ruby boundary. The leading/trailing
 *  boundary is a PAIR of model positions on the same pixel; one is OUTSIDE
 *  the ruby (delim @0 of leading / delim @end of trailing) and the other is
 *  INSIDE (the corresponding delim @end / @0 or body @0/@end). */
type Boundary = {
  /** caret sits at either OUTSIDE or INSIDE leading boundary */
  leading: boolean;
  /** caret sits at OUTSIDE-leading (no .rubyActive highlight) */
  leadingOutside: boolean;
  /** caret sits at either OUTSIDE or INSIDE trailing boundary */
  trailing: boolean;
  /** caret sits at OUTSIDE-trailing (no .rubyActive highlight) */
  trailingOutside: boolean;
};

const NO_BOUNDARY: Boundary = {
  leading: false,
  leadingOutside: false,
  trailing: false,
  trailingOutside: false,
};

/** Locate the cursor relative to its containing ruby's boundary pairs. */
const $boundaryAt = (ruby: RubyNode, node: LexicalNode, offset: number): Boundary => {
  const first = ruby.getFirstChild();
  const last = ruby.getLastChild();
  if (node instanceof DelimNode) {
    const atStart = offset === 0;
    const atEnd = offset === node.getTextContentSize();
    // Leading delim: @0 is OUTSIDE-left, @end is INSIDE-left.
    // Trailing delim: @0 is INSIDE-right, @end is OUTSIDE-right.
    const onLead = node === first;
    const onTrail = node === last;
    return {
      leading: (onLead && atStart) || (onLead && atEnd),
      leadingOutside: onLead && atStart,
      trailing: (onTrail && atStart) || (onTrail && atEnd),
      trailingOutside: onTrail && atEnd,
    };
  }
  // Body is the 2nd child of the ruby (after the leading delim); its @0/@end
  // are the OTHER halves of the INSIDE boundary pairs. The model normally
  // holds the delim side after a click (Lexical normalizes body @0 → delim
  // @end), but cover this side too for correctness.
  const bodyNode = ruby.getChildren()[1];
  if (bodyNode != null && node.is(bodyNode)) {
    return {
      leading: offset === 0,
      leadingOutside: false,
      trailing: offset === node.getTextContentSize(),
      trailingOutside: false,
    };
  }
  return NO_BOUNDARY;
};

/**
 * Compute the four class-toggle keys for a collapsed caret. Pure on the
 * editor state — exported so unit tests can pin down the boundary-pair
 * semantics without driving the DOM (see ./appearance.test.ts).
 */
export const $computeAppearKeys = (anchor: PointType): AppearKeys => {
  const node = anchor.getNode();
  const top = node.getTopLevelElement();
  const paraKey = top ? top.getKey() : null;

  // Find the nearest ruby ancestor (the caret is INSIDE this ruby, but may
  // sit on one of its boundary positions).
  const ruby = node.getParents().find($isRubyNode) ?? ($isRubyNode(node) ? node : null);
  if (!ruby) return { ...EMPTY, paraKey };

  const b = $boundaryAt(ruby, node, anchor.offset);
  // The overlay caret fires at first-child rubies for the leading boundary
  // and last-child rubies for the trailing boundary — mid-paragraph rubies
  // get the native caret (the adjacent text node has a normal 1em font).
  const rubyLeadKey = b.leading && ruby.getPreviousSibling() === null ? ruby.getKey() : null;
  const rubyTrailKey = b.trailing && ruby.getNextSibling() === null ? ruby.getKey() : null;
  // The .rubyActive "inside the rubied text" highlight is off only at the
  // OUTSIDE positions — that no-highlight cue is what distinguishes the
  // boundary pair visually.
  const rubyKey = b.leadingOutside || b.trailingOutside ? null : ruby.getKey();
  return { paraKey, rubyKey, rubyLeadKey, rubyTrailKey };
};

/**
 * Toggle .activePara / .rubyActive / .rubyLeadActive / .rubyTrailActive on
 * the DOM as the selection moves. Returns the unregister function.
 */
export const registerAppearance = (editor: LexicalEditor): (() => void) => {
  const CLASSES = [styles.activePara, styles.rubyActive, styles.rubyLeadActive, styles.rubyTrailActive] as const;
  let prev: (string | null)[] = [null, null, null, null];

  return editor.registerUpdateListener(({ editorState }) => {
    const next = editorState.read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return EMPTY;
      return $computeAppearKeys(sel.anchor);
    });
    const nextKeys = [next.paraKey, next.rubyKey, next.rubyLeadKey, next.rubyTrailKey];
    for (let i = 0; i < CLASSES.length; i++) {
      const cls = CLASSES[i];
      const key = nextKeys[i] ?? null;
      const old = prev[i] ?? null;
      if (cls == null) continue;
      if (old && old !== key) editor.getElementByKey(old)?.classList.remove(cls);
      if (key) editor.getElementByKey(key)?.classList.add(cls);
    }
    prev = nextKeys;
  });
};
