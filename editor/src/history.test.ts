import { describe, expect, it } from 'vitest';
import { PlainTextHistory } from './history';

const noDebounce = (h: PlainTextHistory) => {
  (h as unknown as { lastPushTime: number }).lastPushTime = 0;
};

describe('PlainTextHistory', () => {
  it('initializes with the given text', () => {
    expect(new PlainTextHistory('hello').current()).toEqual({ text: 'hello', cursor: null });
  });

  it('push adds a new entry', () => {
    const h = new PlainTextHistory('hello');
    noDebounce(h);
    h.push({ text: 'world', cursor: { para: 0, offset: 5 } });
    expect(h.current()).toEqual({ text: 'world', cursor: { para: 0, offset: 5 } });
  });

  it('undo returns the previous entry, null at the beginning', () => {
    const h = new PlainTextHistory('hello');
    noDebounce(h);
    h.push({ text: 'world', cursor: null });
    expect(h.undo()).toEqual({ text: 'hello', cursor: null });
    expect(h.undo()).toBeNull();
  });

  it('redo returns the next entry after undo, null at the end', () => {
    const h = new PlainTextHistory('hello');
    noDebounce(h);
    h.push({ text: 'world', cursor: null });
    h.undo();
    expect(h.redo()).toEqual({ text: 'world', cursor: null });
    expect(h.redo()).toBeNull();
  });

  it('push after undo truncates the redo entries', () => {
    const h = new PlainTextHistory('a');
    noDebounce(h);
    h.push({ text: 'b', cursor: null });
    noDebounce(h);
    h.push({ text: 'c', cursor: null });
    h.undo();
    expect(h.current().text).toBe('b');
    noDebounce(h);
    h.push({ text: 'd', cursor: null });
    expect(h.current().text).toBe('d');
    expect(h.redo()).toBeNull();
  });

  it('debounced push after undo truncates instead of overwriting a middle entry', () => {
    const h = new PlainTextHistory('a');
    noDebounce(h);
    h.push({ text: 'b', cursor: null });
    noDebounce(h);
    h.push({ text: 'c', cursor: null });
    h.undo(); // at 'b'
    (h as unknown as { lastPushTime: number }).lastPushTime = Date.now();
    h.push({ text: 'd', cursor: null }); // within debounce window
    expect(h.current().text).toBe('d');
    expect(h.redo()).toBeNull();
    h.undo();
    expect(h.current().text).toBe('b');
  });

  it('undo restores the caret to where it was BEFORE the undone edit', () => {
    // Insert leaves the caret at the end; the user then MOVES back and deletes.
    // Undo must return to the move position (cursorBefore), not the insert end.
    const h = new PlainTextHistory('');
    noDebounce(h);
    h.push({ text: 'hello world', cursor: { para: 0, offset: 11 } }); // insert; caret at end
    noDebounce(h);
    h.push({ text: 'hell world', cursor: { para: 0, offset: 4 }, cursorBefore: { para: 0, offset: 5 } }); // deleted at 5
    expect(h.undo()).toEqual({ text: 'hello world', cursor: { para: 0, offset: 5 } }); // NOT offset 11
  });

  it('redo restores the caret to where the redone edit left it', () => {
    const h = new PlainTextHistory('');
    noDebounce(h);
    h.push({ text: 'hello world', cursor: { para: 0, offset: 11 } });
    noDebounce(h);
    h.push({ text: 'hell world', cursor: { para: 0, offset: 4 }, cursorBefore: { para: 0, offset: 5 } });
    h.undo();
    expect(h.redo()).toEqual({ text: 'hell world', cursor: { para: 0, offset: 4 } }); // the edit's after-caret
  });

  it('a debounced batch keeps the pre-edit caret of its FIRST edit for undo', () => {
    const h = new PlainTextHistory('');
    noDebounce(h);
    h.push({ text: 'ab', cursor: { para: 0, offset: 2 } }); // baseline
    noDebounce(h);
    // Two batched edits (within the debounce window): the 2nd replaces the 1st.
    h.push({ text: 'abc', cursor: { para: 0, offset: 3 }, cursorBefore: { para: 0, offset: 2 } });
    h.push({ text: 'abcd', cursor: { para: 0, offset: 4 }, cursorBefore: { para: 0, offset: 3 } });
    // Undo the batch → back to the FIRST edit's pre-caret (offset 2), not the 2nd's (3).
    expect(h.undo()).toEqual({ text: 'ab', cursor: { para: 0, offset: 2 } });
  });

  it('multiple undo/redo cycles work', () => {
    const h = new PlainTextHistory('a');
    noDebounce(h);
    h.push({ text: 'b', cursor: null });
    noDebounce(h);
    h.push({ text: 'c', cursor: null });
    h.undo();
    h.undo();
    expect(h.current().text).toBe('a');
    h.undo();
    expect(h.current().text).toBe('a');
    h.redo();
    expect(h.current().text).toBe('b');
    h.redo();
    h.redo();
    expect(h.current().text).toBe('c');
  });
});
