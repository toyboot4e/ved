import { describe, expect, it } from 'vitest';
import { activeBuffer, type BuffersState, buffersReducer, initBuffers, isDirty, someInactiveDirty } from './buffers';

const open = (s: BuffersState, path: string, text: string) => buffersReducer(s, { type: 'openPath', path, text });

describe('initBuffers', () => {
  it('starts with one active untitled buffer holding the seed text', () => {
    const s = initBuffers('hello');
    expect(s.buffers).toHaveLength(1);
    expect(activeBuffer(s).text).toBe('hello');
    expect(activeBuffer(s).path).toBeNull();
    expect(isDirty(activeBuffer(s))).toBe(false);
  });
});

describe('openPath', () => {
  it('adds a new buffer and makes it active', () => {
    const s = open(initBuffers(''), '/a.txt', 'A');
    expect(s.buffers).toHaveLength(2);
    expect(activeBuffer(s).path).toBe('/a.txt');
    expect(activeBuffer(s).text).toBe('A');
  });

  it('focuses the existing tab when the path is already open', () => {
    let s = open(initBuffers(''), '/a.txt', 'A');
    s = open(s, '/b.txt', 'B');
    const beforeCount = s.buffers.length;
    s = open(s, '/a.txt', 'A'); // re-open A
    expect(s.buffers).toHaveLength(beforeCount); // no duplicate
    expect(activeBuffer(s).path).toBe('/a.txt');
  });

  it('assigns distinct ids', () => {
    let s = open(initBuffers(''), '/a.txt', 'A');
    s = open(s, '/b.txt', 'B');
    expect(new Set(s.buffers.map((b) => b.id)).size).toBe(s.buffers.length);
  });
});

describe('newUntitled', () => {
  it('adds an empty active buffer', () => {
    const s = buffersReducer(initBuffers('seed'), { type: 'newUntitled' });
    expect(s.buffers).toHaveLength(2);
    expect(activeBuffer(s).text).toBe('');
    expect(activeBuffer(s).path).toBeNull();
  });
});

describe('markSaved', () => {
  it('clears dirty and adopts the path', () => {
    let s = buffersReducer(initBuffers('seed'), { type: 'newUntitled' });
    const id = s.activeId;
    // Simulate an edit committed to the store
    s = buffersReducer(s, {
      type: 'snapshot',
      id,
      text: 'edited',
      cursor: null,
      anchor: null,
      scroll: { top: 0, left: 0 },
    });
    expect(isDirty(activeBuffer(s))).toBe(true);
    s = buffersReducer(s, { type: 'markSaved', id, path: '/new.txt', text: 'edited' });
    expect(isDirty(activeBuffer(s))).toBe(false);
    expect(activeBuffer(s).path).toBe('/new.txt');
  });
});

describe('snapshot', () => {
  it('commits live text, selection, and scroll without touching savedText', () => {
    const s0 = open(initBuffers(''), '/a.txt', 'A');
    const id = s0.activeId;
    const s = buffersReducer(s0, {
      type: 'snapshot',
      id,
      text: 'A edited',
      cursor: { para: 0, offset: 3 },
      anchor: { para: 0, offset: 1 },
      scroll: { top: 40, left: 0 },
    });
    const b = activeBuffer(s);
    expect(b.text).toBe('A edited');
    expect(b.savedText).toBe('A'); // unchanged → now dirty
    expect(isDirty(b)).toBe(true);
    expect(b.cursor).toEqual({ para: 0, offset: 3 });
    expect(b.anchor).toEqual({ para: 0, offset: 1 });
    expect(b.scroll).toEqual({ top: 40, left: 0 });
  });

  it('ignores a snapshot for a closed buffer', () => {
    const s = open(initBuffers(''), '/a.txt', 'A');
    const stale = buffersReducer(s, {
      type: 'snapshot',
      id: 999,
      text: 'x',
      cursor: null,
      anchor: null,
      scroll: { top: 0, left: 0 },
    });
    expect(stale).toEqual(s);
  });
});

describe('close', () => {
  it('falls onto the right neighbor when the active tab closes', () => {
    let s = open(initBuffers(''), '/a.txt', 'A'); // ids 0(untitled),1(A)
    s = open(s, '/b.txt', 'B'); // id 2(B), active
    s = buffersReducer(s, { type: 'setActive', id: 1 }); // focus A
    s = buffersReducer(s, { type: 'close', id: 1 }); // close A
    expect(s.buffers.map((b) => b.path)).toEqual([null, '/b.txt']);
    expect(activeBuffer(s).path).toBe('/b.txt'); // neighbor at the same index
  });

  it('keeps the active tab when a different one closes', () => {
    let s = open(initBuffers(''), '/a.txt', 'A');
    s = open(s, '/b.txt', 'B'); // B active
    const activeId = s.activeId;
    s = buffersReducer(s, { type: 'close', id: 1 }); // close A (inactive)
    expect(s.activeId).toBe(activeId);
    expect(s.buffers).toHaveLength(2);
  });

  it('replaces the last buffer with a fresh untitled rather than going empty', () => {
    const s0 = initBuffers('seed');
    const s = buffersReducer(s0, { type: 'close', id: s0.activeId });
    expect(s.buffers).toHaveLength(1);
    expect(activeBuffer(s).text).toBe('');
    expect(activeBuffer(s).id).not.toBe(s0.activeId); // a new buffer
  });
});

describe('someInactiveDirty', () => {
  it('reports dirtiness of buffers other than the given one', () => {
    let s = open(initBuffers(''), '/a.txt', 'A');
    const aId = s.activeId;
    s = open(s, '/b.txt', 'B'); // B active
    // A is clean
    expect(someInactiveDirty(s, s.activeId)).toBe(false);
    // make A dirty via a committed snapshot
    s = buffersReducer(s, {
      type: 'snapshot',
      id: aId,
      text: 'A!',
      cursor: null,
      anchor: null,
      scroll: { top: 0, left: 0 },
    });
    expect(someInactiveDirty(s, s.activeId)).toBe(true); // A is inactive + dirty
    expect(someInactiveDirty(s, aId)).toBe(false); // excluding A, B is clean
  });
});
