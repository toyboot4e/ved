import { createEditor, type Descendant, Transforms } from 'slate';
import { describe, expect, it } from 'vitest';
import {
  getCursorPlainOffset,
  PlainTextHistory,
  replaceContent,
  restoreCursorSync,
  syncParagraphs,
  withInlines,
  withNormalizeText,
} from './editor-core';
import { serialize } from './rich';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const createTestEditor = (initial: Descendant[]) => {
  const editor = withNormalizeText(withInlines(createEditor()));
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

  it('can replace content multiple times', () => {
    const editor = createTestEditor([paragraph('original')]);
    replaceContent(editor, [paragraph('replaced')]);
    expect(getTexts(editor)).toEqual(['replaced']);

    replaceContent(editor, [paragraph('replaced again')]);
    expect(getTexts(editor)).toEqual(['replaced again']);
  });
});

// ---------------------------------------------------------------------------
// syncParagraphs
// ---------------------------------------------------------------------------

describe('syncParagraphs', () => {
  it('converts ruby syntax into a ruby element', () => {
    const editor = createTestEditor([paragraph('|漢(かん)字')]);
    expect(syncParagraphs(editor)).toBe(true);
    expect(editor.children).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'plaintext', text: '' },
          {
            type: 'ruby',
            children: [
              { type: 'delim', text: '|' },
              { type: 'body', text: '漢' },
              { type: 'delim', text: '(' },
              { type: 'rt', text: 'かん' },
              { type: 'delim', text: ')' },
            ],
          },
          { type: 'plaintext', text: '字' },
        ],
      },
    ]);
  });

  it('is idempotent', () => {
    const editor = createTestEditor([paragraph('|漢(かん)字')]);
    syncParagraphs(editor);
    expect(syncParagraphs(editor)).toBe(false);
  });

  it('flattens a ruby whose syntax broke', () => {
    const editor = createTestEditor([
      {
        type: 'paragraph',
        children: [
          { type: 'plaintext', text: '' },
          {
            type: 'ruby',
            children: [
              { type: 'delim', text: '|' },
              { type: 'body', text: '漢' },
              { type: 'delim', text: '(' },
              { type: 'rt', text: 'かん' },
              // `)` deleted by the user
            ],
          },
          { type: 'plaintext', text: '字' },
        ],
      },
    ]);
    expect(syncParagraphs(editor)).toBe(true);
    expect(editor.children).toEqual([paragraph('|漢(かん字')]);
  });

  it('leaves untouched paragraphs alone and preserves the text', () => {
    const editor = createTestEditor([paragraph('plain'), paragraph('|漢(かん)')]);
    const before = serialize(editor.children);
    syncParagraphs(editor);
    expect(serialize(editor.children)).toBe(before);
    // first paragraph untouched (single plaintext node)
    expect(editor.children[0]).toEqual(paragraph('plain'));
  });
});

// ---------------------------------------------------------------------------
// Cursor save/restore across structure repair
// ---------------------------------------------------------------------------

describe('cursor across syncParagraphs', () => {
  it('survives a paragraph rebuild at the same plain offset', () => {
    const editor = createTestEditor([paragraph('|漢(かん)字')]);
    // Cursor after `ん` (plain offset 5)
    Transforms.select(editor, { anchor: { path: [0, 0], offset: 5 }, focus: { path: [0, 0], offset: 5 } });
    const cursor = getCursorPlainOffset(editor);
    expect(cursor).toEqual({ para: 0, offset: 5 });

    syncParagraphs(editor);
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    restoreCursorSync(editor, cursor!);

    expect(getCursorPlainOffset(editor)).toEqual({ para: 0, offset: 5 });
    // Restored at the same plain offset, biased past the hidden rt boundary
    expect(editor.selection?.anchor).toEqual({ path: [0, 1, 4], offset: 0 });
  });

  it('returns null without a selection', () => {
    const editor = createTestEditor([paragraph('abc')]);
    expect(getCursorPlainOffset(editor)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PlainTextHistory
// ---------------------------------------------------------------------------

describe('PlainTextHistory', () => {
  it('initializes with the given text', () => {
    const history = new PlainTextHistory('hello');
    expect(history.current()).toEqual({ text: 'hello', cursor: null });
  });

  it('push adds a new entry', () => {
    const history = new PlainTextHistory('hello');
    // Force new batch by manipulating internal state
    (history as unknown as { lastPushTime: number }).lastPushTime = 0;
    history.push({ text: 'world', cursor: { para: 0, offset: 5 } });
    expect(history.current()).toEqual({ text: 'world', cursor: { para: 0, offset: 5 } });
  });

  it('undo returns previous entry', () => {
    const history = new PlainTextHistory('hello');
    (history as unknown as { lastPushTime: number }).lastPushTime = 0;
    history.push({ text: 'world', cursor: { para: 0, offset: 5 } });

    const entry = history.undo();
    expect(entry).toEqual({ text: 'hello', cursor: null });
    expect(history.current()).toEqual({ text: 'hello', cursor: null });
  });

  it('undo returns null at the beginning', () => {
    const history = new PlainTextHistory('hello');
    expect(history.undo()).toBeNull();
  });

  it('redo returns next entry after undo', () => {
    const history = new PlainTextHistory('hello');
    (history as unknown as { lastPushTime: number }).lastPushTime = 0;
    history.push({ text: 'world', cursor: { para: 0, offset: 5 } });

    history.undo();
    const entry = history.redo();
    expect(entry).toEqual({ text: 'world', cursor: { para: 0, offset: 5 } });
  });

  it('redo returns null at the end', () => {
    const history = new PlainTextHistory('hello');
    expect(history.redo()).toBeNull();
  });

  it('push after undo truncates redo entries', () => {
    const history = new PlainTextHistory('a');
    (history as unknown as { lastPushTime: number }).lastPushTime = 0;
    history.push({ text: 'b', cursor: null });
    (history as unknown as { lastPushTime: number }).lastPushTime = 0;
    history.push({ text: 'c', cursor: null });

    // Undo to 'b'
    history.undo();
    expect(history.current().text).toBe('b');

    // Push new entry — should truncate 'c'
    (history as unknown as { lastPushTime: number }).lastPushTime = 0;
    history.push({ text: 'd', cursor: null });
    expect(history.current().text).toBe('d');

    // Redo should return null (no 'c' to redo to)
    expect(history.redo()).toBeNull();
  });

  it('debounced push after undo truncates instead of overwriting a middle entry', () => {
    const history = new PlainTextHistory('a');
    (history as unknown as { lastPushTime: number }).lastPushTime = 0;
    history.push({ text: 'b', cursor: null });
    (history as unknown as { lastPushTime: number }).lastPushTime = 0;
    history.push({ text: 'c', cursor: null });

    // Undo to 'b', then push again within the debounce window
    history.undo();
    (history as unknown as { lastPushTime: number }).lastPushTime = Date.now();
    history.push({ text: 'd', cursor: null });

    expect(history.current().text).toBe('d');
    // 'c' must be gone — redoing into a stale future would corrupt the text
    expect(history.redo()).toBeNull();
    history.undo();
    expect(history.current().text).toBe('b');
  });

  it('multiple undo/redo cycles work correctly', () => {
    const history = new PlainTextHistory('a');
    (history as unknown as { lastPushTime: number }).lastPushTime = 0;
    history.push({ text: 'b', cursor: null });
    (history as unknown as { lastPushTime: number }).lastPushTime = 0;
    history.push({ text: 'c', cursor: null });

    expect(history.current().text).toBe('c');

    history.undo();
    expect(history.current().text).toBe('b');

    history.undo();
    expect(history.current().text).toBe('a');

    history.undo(); // at beginning
    expect(history.current().text).toBe('a');

    history.redo();
    expect(history.current().text).toBe('b');

    history.redo();
    expect(history.current().text).toBe('c');

    history.redo(); // at end
    expect(history.current().text).toBe('c');
  });
});
