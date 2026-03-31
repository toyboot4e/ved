import { createEditor, type Descendant } from 'slate';
import { withHistory } from 'slate-history';
import { describe, expect, it } from 'vitest';
import { coupleHistories, replaceContent, withInlines, withNormalizeText } from './editor-core';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const createTestEditor = (initial: Descendant[]) => {
  const editor = withNormalizeText(withInlines(withHistory(createEditor())));
  editor.children = initial;
  editor.onChange();
  return editor;
};

const paragraph = (text: string): Descendant => ({
  type: 'paragraph',
  children: [{ type: 'plaintext', text }],
});

const getTexts = (editor: { children: Descendant[] }): string[] =>
  editor.children.map((node) => {
    if ('children' in node) {
      return (node.children as { text: string }[]).map((c) => c.text).join('');
    }
    return '';
  });

// ---------------------------------------------------------------------------
// replaceContent
// ---------------------------------------------------------------------------

describe('replaceContent', () => {
  it('replaces editor content correctly', () => {
    const editor = createTestEditor([paragraph('hello')]);
    replaceContent(editor, [paragraph('world')]);
    expect(getTexts(editor)).toEqual(['world']);
  });

  it('is undoable as a single step', () => {
    const editor = createTestEditor([paragraph('original')]);
    replaceContent(editor, [paragraph('replaced')]);
    expect(getTexts(editor)).toEqual(['replaced']);

    editor.undo();
    expect(getTexts(editor)).toEqual(['original']);
  });

  it('is redoable after undo', () => {
    const editor = createTestEditor([paragraph('original')]);
    replaceContent(editor, [paragraph('replaced')]);
    editor.undo();
    expect(getTexts(editor)).toEqual(['original']);

    editor.redo();
    expect(getTexts(editor)).toEqual(['replaced']);
  });
});

// ---------------------------------------------------------------------------
// coupleHistories
// ---------------------------------------------------------------------------

describe('coupleHistories', () => {
  // coupleHistories makes undo/redo call origUndoA+origUndoB simultaneously.
  // Each editor has its own independent history stack, so one undo pops from both.

  it('undo on editor A also undoes editor B', () => {
    const a = createTestEditor([paragraph('a1')]);
    const b = createTestEditor([paragraph('b1')]);
    coupleHistories(a, b);

    replaceContent(a, [paragraph('a2')]);
    replaceContent(b, [paragraph('b2')]);

    // One undo pops both stacks: a2→a1, b2→b1
    a.undo();
    expect(getTexts(a)).toEqual(['a1']);
    expect(getTexts(b)).toEqual(['b1']);
  });

  it('redo on editor A also redoes editor B', () => {
    const a = createTestEditor([paragraph('a1')]);
    const b = createTestEditor([paragraph('b1')]);
    coupleHistories(a, b);

    replaceContent(a, [paragraph('a2')]);
    replaceContent(b, [paragraph('b2')]);

    a.undo();
    expect(getTexts(a)).toEqual(['a1']);
    expect(getTexts(b)).toEqual(['b1']);

    // One redo pushes both stacks: a1→a2, b1→b2
    a.redo();
    expect(getTexts(a)).toEqual(['a2']);
    expect(getTexts(b)).toEqual(['b2']);
  });

  it('undo on editor B also undoes editor A (symmetric)', () => {
    const a = createTestEditor([paragraph('a1')]);
    const b = createTestEditor([paragraph('b1')]);
    coupleHistories(a, b);

    replaceContent(a, [paragraph('a2')]);
    replaceContent(b, [paragraph('b2')]);

    b.undo();
    expect(getTexts(a)).toEqual(['a1']);
    expect(getTexts(b)).toEqual(['b1']);
  });
});

// ---------------------------------------------------------------------------
// Integration: simulating mode switch
// ---------------------------------------------------------------------------

describe('integration: mode switch simulation', () => {
  it('edit plain → replaceContent on rich → undo both → both revert', () => {
    const plain = createTestEditor([paragraph('hello')]);
    const rich = createTestEditor([paragraph('hello')]);
    coupleHistories(plain, rich);

    // Simulate editing plain and syncing to rich
    replaceContent(plain, [paragraph('hello world')]);
    replaceContent(rich, [paragraph('hello world')]);

    expect(getTexts(plain)).toEqual(['hello world']);
    expect(getTexts(rich)).toEqual(['hello world']);

    // Coupled undo pops both stacks simultaneously → both revert
    plain.undo();
    expect(getTexts(plain)).toEqual(['hello']);
    expect(getTexts(rich)).toEqual(['hello']);
  });
});
