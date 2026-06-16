// Tests for the cursor-position → ruby-highlight rule (the UX cue the user
// uses to tell apart the two model positions at a ruby boundary):
//   `.rubyActive` ON  when the caret is inside the rubied text.
//   `.rubyActive` OFF when the caret is on the ruby boundary (outside).
// "Boundary" means leading-delim@0 or trailing-delim@end; all other delim
// positions are interior boundaries (between body and rt), still inside.
import { $getRoot, createEditor, type LexicalEditor, type LexicalNode, type ParagraphNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import { $computeAppearKeys } from './appearance';
import { $buildFromText } from './model';
import { DelimNode, RtNode, RubyNode } from './nodes';

const makeEditor = (text: string): LexicalEditor => {
  const editor = createEditor({
    namespace: 'appearance-test',
    nodes: [DelimNode, RtNode, RubyNode],
    onError: (e) => {
      throw e;
    },
  });
  editor.update(() => $buildFromText(text), { discrete: true });
  return editor;
};

/** Compute appear keys for a synthetic anchor at (node, offset). Pure on
 *  the editor state — no need to actually seat a selection. */
const at = (editor: LexicalEditor, node: LexicalNode, offset: number) =>
  editor
    .getEditorState()
    .read(() => $computeAppearKeys({ key: node.getKey(), offset, type: 'text', getNode: () => node } as never));

// Helpers to find specific leaves in the canonical ruby `|漢(かん)字`. All
// `getTextContentSize` calls happen inside the read; the returned values are
// pre-computed numbers so tests don't reach into the editor state again.
type Layout = {
  leadDelim: DelimNode;
  leadDelimLen: number;
  body: LexicalNode;
  bodyLen: number;
  sep: DelimNode;
  rt: RtNode;
  rtLen: number;
  trailDelim: DelimNode;
  trailDelimLen: number;
  ruby: RubyNode;
};
const layout = (editor: LexicalEditor): Layout =>
  editor.getEditorState().read(() => {
    const para = $getRoot().getFirstChild() as ParagraphNode;
    const ruby = para.getChildren().find((c): c is RubyNode => c instanceof RubyNode);
    if (!ruby) throw new Error('no ruby');
    const children = ruby.getChildren();
    const leadDelim = children[0] as DelimNode;
    const body = children[1]!;
    const sep = children[2] as DelimNode;
    const rt = children[3] as RtNode;
    const trailDelim = children[4] as DelimNode;
    return {
      ruby,
      leadDelim,
      leadDelimLen: leadDelim.getTextContentSize(),
      body,
      bodyLen: body.getTextContentSize(),
      sep,
      rt,
      rtLen: rt.getTextContentSize(),
      trailDelim,
      trailDelimLen: trailDelim.getTextContentSize(),
    };
  });

describe('appearance / ruby boundary', () => {
  it('leading delim @0 is OUTSIDE the ruby (no highlight)', () => {
    const editor = makeEditor('|漢(かん)字');
    const { leadDelim, leadDelimLen, ruby } = layout(editor);
    expect(at(editor, leadDelim, 0).rubyKey).toBeNull();
    // contrast: leading delim @end is paired with body@0 — INSIDE
    expect(at(editor, leadDelim, leadDelimLen).rubyKey).toBe(ruby.getKey());
  });

  it('trailing delim @end is OUTSIDE the ruby (no highlight)', () => {
    const editor = makeEditor('|漢(かん)字');
    const { trailDelim, trailDelimLen, ruby } = layout(editor);
    expect(at(editor, trailDelim, trailDelimLen).rubyKey).toBeNull();
    // contrast: trailing delim @0 is paired with body/rt @end — INSIDE
    expect(at(editor, trailDelim, 0).rubyKey).toBe(ruby.getKey());
  });

  it('body positions are INSIDE the ruby (highlight)', () => {
    const editor = makeEditor('|漢(かん)字');
    const { body, ruby } = layout(editor);
    expect(at(editor, body, 0).rubyKey).toBe(ruby.getKey());
    expect(at(editor, body, 1).rubyKey).toBe(ruby.getKey());
  });

  it('rt positions and interior delims are INSIDE the ruby', () => {
    const editor = makeEditor('|漢(かん)字');
    const { sep, rt, rtLen, ruby } = layout(editor);
    // interior delim `(` — between body and rt
    expect(at(editor, sep, 0).rubyKey).toBe(ruby.getKey());
    expect(at(editor, sep, 1).rubyKey).toBe(ruby.getKey());
    // rt content (the reading)
    expect(at(editor, rt, 0).rubyKey).toBe(ruby.getKey());
    expect(at(editor, rt, rtLen).rubyKey).toBe(ruby.getKey());
  });

  it('plaintext outside any ruby has no highlight', () => {
    const editor = makeEditor('|漢(かん)字');
    const trailingText = editor.getEditorState().read(() => {
      const para = $getRoot().getFirstChild() as ParagraphNode;
      const children = para.getChildren();
      return children[children.length - 1]!;
    });
    expect(at(editor, trailingText, 0).rubyKey).toBeNull();
  });

  it('paraKey is always the active paragraph', () => {
    const editor = makeEditor('|漢(かん)字');
    const { body } = layout(editor);
    const paraKey = editor.getEditorState().read(() => $getRoot().getFirstChild()!.getKey());
    expect(at(editor, body, 0).paraKey).toBe(paraKey);
  });

  // rubyLeadKey activates ONLY when the leading-delim @0 caret sits on a
  // ruby that is the first child of its paragraph (the doc-start "small
  // cursor" UX issue). Drives the overlay pseudo-element (ruby.module.scss
  // .rubyLeadActive::before).
  describe('rubyLeadKey (leading-delim overlay caret)', () => {
    it('is the ruby key at leading delim @0 when the ruby starts the paragraph', () => {
      const editor = makeEditor('|漢(かん)');
      const { leadDelim, ruby } = layout(editor);
      expect(at(editor, leadDelim, 0).rubyLeadKey).toBe(ruby.getKey());
    });

    it('is null at leading delim @0 when the ruby is NOT the first child', () => {
      const editor = makeEditor('字は|漢(かん)');
      const { leadDelim } = layout(editor);
      expect(at(editor, leadDelim, 0).rubyLeadKey).toBeNull();
    });

    it('is the ruby key at leading delim @end (the INSIDE-left pair partner)', () => {
      // Both members of the boundary pair fire the overlay class. Lexical
      // normalizes body @0 → leading delim @end so this is the position the
      // model actually holds at INSIDE-left.
      const editor = makeEditor('|漢(かん)');
      const { leadDelim, leadDelimLen, ruby } = layout(editor);
      expect(at(editor, leadDelim, leadDelimLen).rubyLeadKey).toBe(ruby.getKey());
    });

    it('is the ruby key at body @0 of a first-child ruby (INSIDE-left pair)', () => {
      const editor = makeEditor('|漢(かん)');
      const { body, ruby } = layout(editor);
      expect(at(editor, body, 0).rubyLeadKey).toBe(ruby.getKey());
    });
  });

  // rubyTrailKey activates ONLY when the trailing-delim @end caret sits on a
  // ruby that is the last child of its paragraph (the "no visible cursor at
  // end of rubied text" bug). Mid-paragraph trailing-outside positions stay
  // null so they don't trigger a layout-shifting trailing-delim expansion.
  describe('rubyTrailKey (trailing-delim caret expansion)', () => {
    it('is the ruby key at trailing delim @end when the ruby ends the paragraph', () => {
      const editor = makeEditor('|漢(かん)');
      const { trailDelim, trailDelimLen, ruby } = layout(editor);
      expect(at(editor, trailDelim, trailDelimLen).rubyTrailKey).toBe(ruby.getKey());
    });

    it('is null at trailing delim @end when the ruby is NOT the last child', () => {
      // `|漢(かん)字` — text node `字` follows the ruby.
      const editor = makeEditor('|漢(かん)字');
      const { trailDelim, trailDelimLen } = layout(editor);
      expect(at(editor, trailDelim, trailDelimLen).rubyTrailKey).toBeNull();
    });

    it('is the ruby key at body @end of a last-child ruby (INSIDE-right pair)', () => {
      // body @end is the boundary-pair partner of trailing-delim @0 — same
      // pixel position. Without the overlay class here, Chromium renders the
      // native caret using the body's metrics … but the user's complaint at
      // INSIDE-LEFT suggests Chromium reaches across the boundary into the
      // small-font neighbor. Fire the overlay class here too for symmetry
      // with the leading side.
      const editor = makeEditor('|漢(かん)');
      const { body, bodyLen, ruby } = layout(editor);
      expect(at(editor, body, bodyLen).rubyTrailKey).toBe(ruby.getKey());
    });

    it('is null at non-boundary positions of a last-child ruby', () => {
      const editor = makeEditor('|漢(かん)');
      const { leadDelim, leadDelimLen, body, sep, rt, rtLen, trailDelim, ruby } = layout(editor);
      // leading delim @0 (outside-left) — not the trailing edge
      expect(at(editor, leadDelim, 0).rubyTrailKey).toBeNull();
      // leading delim @end (inside, boundary-pair partner of body @0)
      expect(at(editor, leadDelim, leadDelimLen).rubyTrailKey).toBeNull();
      // body @0 is the LEAD boundary, not trail
      expect(at(editor, body, 0).rubyTrailKey).toBeNull();
      // interior delim
      expect(at(editor, sep, 0).rubyTrailKey).toBeNull();
      expect(at(editor, sep, 1).rubyTrailKey).toBeNull();
      // rt (not body — the rt sits between sep and trailing delim)
      expect(at(editor, rt, 0).rubyTrailKey).toBeNull();
      expect(at(editor, rt, rtLen).rubyTrailKey).toBeNull();
      // trailing delim @0 is the INSIDE-right pair partner — overlay fires.
      expect(at(editor, trailDelim, 0).rubyTrailKey).toBe(ruby.getKey());
    });
  });

  it('multi-paragraph: paraKey follows the cursor across paragraphs', () => {
    const editor = makeEditor('plain\n|漢(かん)字');
    const { p1Key, p2Key, p1Text, p2Body } = editor.getEditorState().read(() => {
      const cs = $getRoot().getChildren();
      const p1 = cs[0]! as ParagraphNode;
      const p2 = cs[1]! as ParagraphNode;
      const ruby = p2.getChildren().find((c): c is RubyNode => c instanceof RubyNode)!;
      return {
        p1Key: p1.getKey(),
        p2Key: p2.getKey(),
        p1Text: p1.getFirstChild() as LexicalNode,
        p2Body: ruby.getChildren()[1] as LexicalNode,
      };
    });
    expect(at(editor, p1Text, 0).paraKey).toBe(p1Key);
    expect(at(editor, p1Text, 0).rubyKey).toBeNull();
    expect(at(editor, p2Body, 0).paraKey).toBe(p2Key);
  });
});
