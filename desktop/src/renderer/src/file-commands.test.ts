import { describe, expect, it } from 'vitest';
import type { VedFileApi } from '../../shared/ipc';
import { dirName, fileName, saveOrSaveAs, windowTitle } from './file-commands';

const fakeApi = (overrides: Partial<VedFileApi>): VedFileApi => ({
  cliFiles: () => Promise.resolve([]),
  openFile: () => Promise.resolve(null),
  saveFile: () => Promise.resolve(),
  saveFileAs: () => Promise.resolve(null),
  readFile: () => Promise.resolve({ kind: 'text', text: '' }),
  readDir: () => Promise.resolve([]),
  openDirDialog: () => Promise.resolve(null),
  renamePath: (path) => Promise.resolve({ kind: 'renamed', newPath: path }),
  deletePath: () => Promise.resolve({ kind: 'deleted' }),
  listWorkspaceFiles: () => Promise.resolve([]),
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

describe('dirName', () => {
  it('yields the parent directory', () => {
    expect(dirName('/home/me/novel/第一章.txt')).toBe('/home/me/novel');
    expect(dirName('C:\\docs\\a.txt')).toBe('C:\\docs');
  });

  it('keeps the root and rejects bare names', () => {
    expect(dirName('/a.txt')).toBe('/');
    expect(dirName('a.txt')).toBeUndefined();
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
