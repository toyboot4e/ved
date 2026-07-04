import { describe, expect, it } from 'vitest';
import type { VedFileApi } from '../../shared/ipc';
import {
  type ChordEvent,
  fileName,
  matchFileCommand,
  matchTabCommand,
  saveOrSaveAs,
  windowTitle,
} from './file-commands';

const fakeApi = (overrides: Partial<VedFileApi>): VedFileApi => ({
  cliFiles: () => Promise.resolve([]),
  openFile: () => Promise.resolve(null),
  saveFile: () => Promise.resolve(),
  saveFileAs: () => Promise.resolve(null),
  ...overrides,
});

describe('saveOrSaveAs', () => {
  it('writes to the known path without a dialog', async () => {
    const calls: [string, string][] = [];
    const api = fakeApi({
      saveFile: (path, text) => {
        calls.push([path, text]);
        return Promise.resolve();
      },
    });
    expect(await saveOrSaveAs(api, '/tmp/a.txt', 'text')).toBe('/tmp/a.txt');
    expect(calls).toEqual([['/tmp/a.txt', 'text']]);
  });

  it('falls back to the save dialog when untitled', async () => {
    const api = fakeApi({ saveFileAs: () => Promise.resolve({ path: '/tmp/b.txt' }) });
    expect(await saveOrSaveAs(api, null, 'text')).toBe('/tmp/b.txt');
  });

  it('returns null when the save dialog is canceled', async () => {
    expect(await saveOrSaveAs(fakeApi({}), null, 'text')).toBeNull();
  });
});

describe('matchFileCommand', () => {
  const chord = (overrides: Partial<ChordEvent>): ChordEvent => ({
    key: 's',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 83,
    ...overrides,
  });

  it('maps the platform mod key', () => {
    expect(matchFileCommand(chord({ key: 'o', ctrlKey: true }), false)).toBe('open');
    expect(matchFileCommand(chord({ key: 'o', metaKey: true }), true)).toBe('open');
    // The other platform's mod key does not count
    expect(matchFileCommand(chord({ key: 'o', metaKey: true }), false)).toBeNull();
    expect(matchFileCommand(chord({ key: 'o', ctrlKey: true }), true)).toBeNull();
  });

  it('distinguishes save from save-as by shift', () => {
    expect(matchFileCommand(chord({ ctrlKey: true }), false)).toBe('save');
    expect(matchFileCommand(chord({ key: 'S', ctrlKey: true, shiftKey: true }), false)).toBe('saveAs');
  });

  it('ignores chords mid-IME-composition', () => {
    expect(matchFileCommand(chord({ ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(matchFileCommand(chord({ ctrlKey: true, keyCode: 229 }), false)).toBeNull();
  });

  it('ignores unrelated keys and alt chords', () => {
    expect(matchFileCommand(chord({ key: 'p', ctrlKey: true }), false)).toBeNull();
    expect(matchFileCommand(chord({ ctrlKey: true, altKey: true }), false)).toBeNull();
  });
});

describe('matchTabCommand', () => {
  const chord = (overrides: Partial<ChordEvent>): ChordEvent => ({
    key: 'n',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 78,
    ...overrides,
  });

  it('maps new/close on the platform mod key', () => {
    expect(matchTabCommand(chord({ key: 'n', ctrlKey: true }), false)).toBe('new');
    expect(matchTabCommand(chord({ key: 'n', metaKey: true }), true)).toBe('new');
    expect(matchTabCommand(chord({ key: 'w', ctrlKey: true }), false)).toBe('close');
    expect(matchTabCommand(chord({ key: 'w', metaKey: true }), true)).toBe('close');
  });

  it('cycles with Ctrl+Tab on both platforms, never Cmd', () => {
    expect(matchTabCommand(chord({ key: 'Tab', ctrlKey: true }), false)).toBe('next');
    expect(matchTabCommand(chord({ key: 'Tab', ctrlKey: true }), true)).toBe('next'); // mac too
    expect(matchTabCommand(chord({ key: 'Tab', ctrlKey: true, shiftKey: true }), true)).toBe('prev');
    // Cmd+Tab is the macOS app switcher — not ours
    expect(matchTabCommand(chord({ key: 'Tab', metaKey: true }), true)).toBeNull();
  });

  it('ignores composition, alt, and unrelated keys', () => {
    expect(matchTabCommand(chord({ key: 'n', ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(matchTabCommand(chord({ key: 'n', ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(matchTabCommand(chord({ key: 'q', ctrlKey: true }), false)).toBeNull();
  });
});

describe('fileName / windowTitle', () => {
  it('uses the base name of the path', () => {
    expect(fileName('/home/me/novel/第一章.txt')).toBe('第一章.txt');
    expect(windowTitle('/home/me/novel/第一章.txt', false)).toBe('第一章.txt — ved');
  });

  it('falls back to a placeholder when untitled', () => {
    expect(fileName(null)).toBe('無題');
    expect(windowTitle(null, false)).toBe('無題 — ved');
  });

  it('marks dirty documents', () => {
    expect(windowTitle('/tmp/a.txt', true)).toBe('● a.txt — ved');
    expect(windowTitle(null, true)).toBe('● 無題 — ved');
  });
});
