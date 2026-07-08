import { describe, expect, it } from 'vitest';
import type { WorkspaceFile } from '../../shared/ipc';
import { type BufferEntry, isTextLabel, RESULT_LIMIT, rankBuffers, rankFiles, useQuickOpenStore } from './quick-open';

const files = (...labels: string[]): WorkspaceFile[] => labels.map((label) => ({ path: `/${label}`, label }));

const buffers = (...labels: (string | null)[]): BufferEntry[] =>
  labels.map((path, i) => ({ id: i + 1, path, label: path ?? '無題' }));

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

  it('with textOnly, drops known-binary extensions before ranking', () => {
    const pool = files('notes.txt', 'photo.png', 'README', 'archive.zip');
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

describe('isTextLabel', () => {
  it('keeps text and extensionless files, drops known binaries', () => {
    expect(isTextLabel('a.txt')).toBe(true);
    expect(isTextLabel('sub/README')).toBe(true);
    expect(isTextLabel('icon.svg')).toBe(true); // SVG is text
    expect(isTextLabel('a.png')).toBe(false);
    expect(isTextLabel('lib.so')).toBe(false);
    expect(isTextLabel('doc.pdf')).toBe(false);
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
