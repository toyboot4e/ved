import { describe, expect, it } from 'vitest';
import type { WorkspaceFile } from '../../shared/ipc';
import {
  type BufferEntry,
  grepResultItems,
  RESULT_LIMIT,
  rankBufferGrep,
  rankBuffers,
  rankFiles,
  useQuickOpenStore,
} from './quick-open';

const files = (...labels: string[]): WorkspaceFile[] =>
  // A `!bin` suffix stands in for main's "not text" sniff verdict
  labels.map((label) => ({ path: `/${label}`, label, isText: !label.endsWith('!bin') }));

const buffers = (...labels: (string | null)[]): BufferEntry[] =>
  labels.map((path, i) => ({ id: i + 1, path, label: path ?? '無題', text: `本文 ${path ?? '無題'}\n二行目\n` }));

describe('rankFiles', () => {
  it('returns the whole list, unranked, for an empty query', () => {
    const { items, total } = rankFiles(files('a.txt', 'b.txt'), '', false);
    expect(items.map((i) => i.label)).toEqual(['a.txt', 'b.txt']);
    expect(items[0]?.matched).toEqual([]);
    expect(total).toBe(2);
  });

  it('caps the rendered list at the result limit but reports the full total', () => {
    const many = files(...Array.from({ length: RESULT_LIMIT + 10 }, (_, i) => `f${i}.txt`));
    const { items, total } = rankFiles(many, '', false);
    expect(items).toHaveLength(RESULT_LIMIT);
    expect(total).toBe(RESULT_LIMIT + 10);
  });

  it('fuzzy-matches non-contiguous characters and reports match indices', () => {
    const { items } = rankFiles(files('sub/deep.txt', 'alpha.txt'), 'dp', false);
    expect(items[0]?.label).toBe('sub/deep.txt');
    // Each matched index points at a char of the label that the query hit.
    const label = items[0]!.label;
    expect(items[0]!.matched.map((i) => label[i]).join('')).toBe('dp');
  });

  it('drops files that do not match', () => {
    const { items, total } = rankFiles(files('alpha.txt', 'beta.txt'), 'zzz', false);
    expect(items).toEqual([]);
    expect(total).toBe(0);
  });

  it('with textOnly, drops files main sniffed as non-text before ranking', () => {
    const pool = files('notes.txt', 'photo.png!bin', 'README', 'movie.iso!bin');
    expect(rankFiles(pool, '', true).items.map((i) => i.label)).toEqual(['notes.txt', 'README']);
    // The filter is off by default.
    expect(rankFiles(pool, '', false).items).toHaveLength(4);
  });

  it('produces file items: path set, no bufferId', () => {
    const { items } = rankFiles(files('a.txt'), '', false);
    expect(items[0]).toMatchObject({ path: '/a.txt', bufferId: null, key: '/a.txt' });
  });
});

describe('rankBuffers', () => {
  it('ranks the open buffers by label and carries the buffer id', () => {
    const pool = buffers('/ws/alpha.txt', '/ws/beta.txt', null);
    const { items, total } = rankBuffers(pool, '');
    expect(total).toBe(3);
    expect(items.map((i) => i.label)).toEqual(['/ws/alpha.txt', '/ws/beta.txt', '無題']);
    expect(items[0]).toMatchObject({ bufferId: 1, path: '/ws/alpha.txt' });
    // An untitled buffer has no path (no preview) but is still selectable.
    expect(items[2]).toMatchObject({ bufferId: 3, path: null });
  });

  it('fuzzy-filters buffers', () => {
    const { items } = rankBuffers(buffers('/ws/alpha.txt', '/ws/beta.txt'), 'bta');
    expect(items.map((i) => i.label)).toEqual(['/ws/beta.txt']);
  });
});

describe('quick-open store modes', () => {
  it('openPalette defaults to files mode; an explicit mode starts there', () => {
    const s = useQuickOpenStore.getState();
    s.openPalette();
    expect(useQuickOpenStore.getState().mode).toBe('files');
    expect(useQuickOpenStore.getState().loading).toBe(true);
    s.close();
    s.openPalette('buffers');
    expect(useQuickOpenStore.getState().mode).toBe('buffers');
    // The buffer pool is synchronous — no loading phase.
    expect(useQuickOpenStore.getState().loading).toBe(false);
    s.close();
  });

  it('setMode switches pools and re-ranks, keeping the query', () => {
    const s = useQuickOpenStore.getState();
    s.openPalette();
    s.setFiles(files('alpha.txt', 'beta.txt'));
    s.setBuffers(buffers('/ws/beta.txt'));
    s.setQuery('beta');
    expect(useQuickOpenStore.getState().items.map((i) => i.label)).toEqual(['beta.txt']);
    s.setMode('buffers');
    const after = useQuickOpenStore.getState();
    expect(after.query).toBe('beta');
    expect(after.items.map((i) => i.label)).toEqual(['/ws/beta.txt']);
    expect(after.items[0]?.bufferId).toBe(1);
    s.close();
  });
});

describe('rankBufferGrep', () => {
  it('matches buffer lines, carrying buffer id, line and column', () => {
    const pool = buffers('/ws/alpha.txt', '/ws/beta.txt');
    const { items, total } = rankBufferGrep(pool, '二行目');
    expect(total).toBe(2);
    expect(items[0]).toMatchObject({ bufferId: 1, line: 2, col: 0, detail: '二行目' });
    expect(items[0]!.detailMatched).toEqual([0, 1, 2]);
  });

  it('an empty query matches nothing', () => {
    expect(rankBufferGrep(buffers('/a'), '')).toEqual({ items: [], total: 0 });
  });
});

describe('grepResultItems', () => {
  it('maps main grep matches onto palette rows', () => {
    const { items, total } = grepResultItems({
      matches: [{ path: '/ws/a.txt', label: 'a.txt', line: 3, col: 5, text: 'あの ことば', matched: [3, 4, 5] }],
      total: 7,
    });
    expect(total).toBe(7);
    expect(items[0]).toMatchObject({
      path: '/ws/a.txt',
      bufferId: null,
      line: 3,
      col: 5,
      detail: 'あの ことば',
      key: 'grep:/ws/a.txt:3:5',
    });
  });
});

describe('content search state', () => {
  it('buffers content search ranks synchronously; files content search awaits main', () => {
    const s = useQuickOpenStore.getState();
    s.openPalette('buffers');
    s.setBuffers(buffers('/ws/alpha.txt'));
    s.toggleContentSearch();
    s.setQuery('二行目');
    expect(useQuickOpenStore.getState().items[0]).toMatchObject({ line: 2, bufferId: 1 });
    expect(useQuickOpenStore.getState().grepping).toBe(false);
    // Files mode: the list empties and grepping goes up until main answers
    s.setMode('files');
    let st = useQuickOpenStore.getState();
    expect(st.items).toEqual([]);
    expect(st.grepping).toBe(true);
    s.setGrepResult({ matches: [], total: 0 });
    st = useQuickOpenStore.getState();
    expect(st.grepping).toBe(false);
    s.close();
  });

  it('content search resets on open (a per-open mode, unlike textOnly)', () => {
    const s = useQuickOpenStore.getState();
    s.openPalette();
    s.toggleContentSearch();
    expect(useQuickOpenStore.getState().contentSearch).toBe(true);
    s.close();
    s.openPalette();
    expect(useQuickOpenStore.getState().contentSearch).toBe(false);
    s.close();
  });
});

describe('setListWidthPct', () => {
  it('clamps the divider to sane bounds (one-decimal precision)', () => {
    const s = () => useQuickOpenStore.getState();
    expect(s().listWidthPct).toBe(44);
    s().setListWidthPct(60.24);
    expect(s().listWidthPct).toBe(60.2);
    s().setListWidthPct(5);
    expect(s().listWidthPct).toBe(15);
    s().setListWidthPct(99);
    expect(s().listWidthPct).toBe(85);
    s().setListWidthPct(44); // restore the default for other tests
  });
});
