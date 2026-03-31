import { createEditor, type Descendant } from 'slate';
import { describe, expect, it } from 'vitest';
import { PlainTextHistory, replaceContent, withInlines, withNormalizeText } from './editor-core';

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
