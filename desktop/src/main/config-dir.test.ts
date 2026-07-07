import { describe, expect, it } from 'vitest';
import { configDirFlag, defaultConfigDir, devExtensionFlags, resolveConfigDir } from './config-dir';

describe('configDirFlag', () => {
  it('reads the equals-form flag', () => {
    expect(configDirFlag(['electron', 'main.js', '--config-dir=/tmp/conf'])).toBe('/tmp/conf');
  });

  it('is null when absent, empty-valued, or space-separated', () => {
    expect(configDirFlag(['electron', 'main.js'])).toBeNull();
    expect(configDirFlag(['electron', '--config-dir='])).toBeNull();
    // The space form would make the value a positional file argument — not a flag.
    expect(configDirFlag(['electron', '--config-dir', '/tmp/conf'])).toBeNull();
  });

  it('lets the last occurrence win', () => {
    expect(configDirFlag(['x', '--config-dir=/a', '--config-dir=/b'])).toBe('/b');
  });
});

describe('defaultConfigDir', () => {
  it('follows XDG on Linux, with the ~/.config fallback', () => {
    expect(defaultConfigDir('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/u')).toBe('/xdg/ved');
    expect(defaultConfigDir('linux', {}, '/home/u')).toBe('/home/u/.config/ved');
  });

  it('uses Application Support on macOS and APPDATA on Windows', () => {
    expect(defaultConfigDir('darwin', {}, '/Users/u')).toBe('/Users/u/Library/Application Support/ved');
    expect(defaultConfigDir('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u')).toBe(
      'C:\\Users\\u\\AppData\\Roaming/ved',
    );
  });
});

describe('devExtensionFlags', () => {
  it('collects every occurrence, resolved against cwd', () => {
    expect(devExtensionFlags(['x', '--dev-extension=/abs', '--dev-extension=rel', '--other'], '/cwd')).toEqual([
      '/abs',
      '/cwd/rel',
    ]);
    expect(devExtensionFlags(['x'], '/cwd')).toEqual([]);
  });
});

describe('resolveConfigDir', () => {
  it('prefers the flag, resolved against cwd', () => {
    expect(resolveConfigDir(['x', '--config-dir=conf'], 'linux', {}, '/home/u', '/cwd')).toBe('/cwd/conf');
    expect(resolveConfigDir(['x', '--config-dir=/abs'], 'linux', {}, '/home/u', '/cwd')).toBe('/abs');
  });

  it('falls back to the platform default', () => {
    expect(resolveConfigDir(['x'], 'linux', {}, '/home/u', '/cwd')).toBe('/home/u/.config/ved');
  });
});
