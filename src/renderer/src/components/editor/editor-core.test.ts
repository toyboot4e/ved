import { createEditor, type Descendant, Transforms } from 'slate';
import { describe, expect, it } from 'vitest';
import {
  getCursorPlainOffset,
  moveCaretByCharacter,
  PlainTextHistory,
  replaceContent,
  restoreCursorSync,
  syncParagraphs,
  withInlines,
  withNormalizeText,
} from './editor-core';
import { AppearPolicy, serialize } from './rich';

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
// Character movement (model-driven caret stops)
// ---------------------------------------------------------------------------

describe('moveCaretByCharacter', () => {
  /** 字は|漢(かん)字 → ['字は', ruby[|, 漢, (, かん, )], '字'] */
  const makeEditor = () => {
    const editor = createTestEditor([paragraph('字は|漢(かん)字')]);
    syncParagraphs(editor);
    return editor;
  };

  const walk = (editor: ReturnType<typeof makeEditor>, policy: AppearPolicy, reverse: boolean): string[] => {
    const seq: string[] = [];
    for (let i = 0; i < 20; i++) {
      const before = JSON.stringify(editor.selection?.focus);
      moveCaretByCharacter(editor, policy, { reverse, extend: false });
      const focus = editor.selection?.focus;
      if (JSON.stringify(focus) === before) break; // document edge
      seq.push(`${focus?.path.join('.')}@${focus?.offset}`);
    }
    return seq;
  };

  it('Rich: both boundary stops exist on BOTH sides of a collapsed ruby', () => {
    const editor = makeEditor();
    Transforms.select(editor, { path: [0, 0], offset: 0 });

    expect(walk(editor, AppearPolicy.Rich, false)).toEqual([
      '0.0@1', // 字|は
      '0.0@2', // 字は| — outside, before the ruby
      '0.1.1@0', // inside, body start (same visual spot: the boundary stop)
      '0.1.1@1', // 漢| — inside, body end
      '0.2@0', // outside, after the ruby (same visual spot: the boundary stop)
      '0.2@1', // 字|
    ]);
  });

  it('Rich: reverse walk is symmetric', () => {
    const editor = makeEditor();
    Transforms.select(editor, { path: [0, 2], offset: 1 });

    expect(walk(editor, AppearPolicy.Rich, true)).toEqual([
      '0.2@0', // outside, after the ruby
      '0.1.1@1', // inside, body end
      '0.1.1@0', // inside, body start
      '0.0@2', // outside, before the ruby
      '0.0@1',
      '0.0@0',
    ]);
  });

  it('ShowAll: every markup character is a stop, interior junctions deduped', () => {
    const editor = makeEditor();
    Transforms.select(editor, { path: [0, 0], offset: 2 });

    expect(walk(editor, AppearPolicy.ShowAll, false)).toEqual([
      '0.1.0@0', // ruby start edge (pairs with 字は@2)
      '0.1.0@1', // |
      '0.1.1@1', // 漢
      '0.1.2@1', // (
      '0.1.3@1', // か
      '0.1.3@2', // ん
      '0.1.4@1', // ) — ruby end edge
      '0.2@0', // outside (pairs with the edge)
      '0.2@1', // 字
    ]);
  });

  it('ByCharacter: entering from the end lands AFTER the whole syntax', () => {
    const editor = makeEditor();
    Transforms.select(editor, { path: [0, 2], offset: 0 });

    moveCaretByCharacter(editor, AppearPolicy.ByCharacter, { reverse: true, extend: false });
    // After `)` — the end of the now-expanded |漢(かん)
    expect(editor.selection?.focus).toEqual({ path: [0, 1, 4], offset: 1 });

    // Continued backward movement walks the expanded syntax
    moveCaretByCharacter(editor, AppearPolicy.ByCharacter, { reverse: true, extend: false });
    expect(editor.selection?.focus).toEqual({ path: [0, 1, 4], offset: 0 }); // before `)`
  });

  it('ByCharacter: entering from the start lands BEFORE the whole syntax', () => {
    const editor = makeEditor();
    Transforms.select(editor, { path: [0, 0], offset: 2 });

    moveCaretByCharacter(editor, AppearPolicy.ByCharacter, { reverse: false, extend: false });
    // Before `|` — the start of the now-expanded |漢(かん)
    expect(editor.selection?.focus).toEqual({ path: [0, 1, 0], offset: 0 });

    moveCaretByCharacter(editor, AppearPolicy.ByCharacter, { reverse: false, extend: false });
    expect(editor.selection?.focus).toEqual({ path: [0, 1, 0], offset: 1 }); // after `|`
  });

  it('extend grows the selection instead of moving it', () => {
    const editor = makeEditor();
    Transforms.select(editor, { path: [0, 0], offset: 0 });
    moveCaretByCharacter(editor, AppearPolicy.Rich, { reverse: false, extend: true });
    expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 0 });
    expect(editor.selection?.focus).toEqual({ path: [0, 0], offset: 1 });
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
