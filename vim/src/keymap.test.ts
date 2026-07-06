import { describe, expect, it } from 'vitest';
import { compileKeymap, walkKeymap } from './keymap';
import { plainKey } from './keys';

describe('compileKeymap + walkKeymap', () => {
  it('compiles a single-key mapping (noremap by default)', () => {
    const km = compileKeymap({ normal: { H: '0' } });
    const walk = walkKeymap(km.normal, [plainKey('H')]);
    expect(walk).toEqual({ kind: 'match', binding: { keys: [plainKey('0')], remap: false } });
  });

  it('carries the remap flag from the object RHS form', () => {
    const km = compileKeymap({ normal: { H: { rhs: '0', remap: true } } });
    const walk = walkKeymap(km.normal, [plainKey('H')]);
    expect(walk.kind === 'match' && walk.binding.remap).toBe(true);
  });

  it('walks multi-key LHS: strict prefix = pending, full = match, off = miss', () => {
    const km = compileKeymap({ normal: { gw: 'b' } });
    expect(walkKeymap(km.normal, [plainKey('g')]).kind).toBe('pending');
    expect(walkKeymap(km.normal, [plainKey('g'), plainKey('w')]).kind).toBe('match');
    expect(walkKeymap(km.normal, [plainKey('g'), plainKey('x')]).kind).toBe('miss');
    expect(walkKeymap(km.normal, [plainKey('q')]).kind).toBe('miss');
  });

  it('map modes are independent tries', () => {
    const km = compileKeymap({ visual: { H: '0' } });
    expect(walkKeymap(km.visual, [plainKey('H')]).kind).toBe('match');
    expect(walkKeymap(km.normal, [plainKey('H')]).kind).toBe('miss');
  });

  it('distinguishes Ctrl-chords from plain keys', () => {
    const km = compileKeymap({ normal: { '<C-h>': '0' } });
    expect(walkKeymap(km.normal, [{ ...plainKey('h'), ctrl: true }]).kind).toBe('match');
    expect(walkKeymap(km.normal, [plainKey('h')]).kind).toBe('miss');
  });

  it('rejects prefix conflicts (a pure reducer cannot time out to disambiguate)', () => {
    expect(() => compileKeymap({ normal: { g: '0', gw: 'b' } })).toThrow(/prefix/);
    expect(() => compileKeymap({ normal: { gw: 'b', g: '0' } })).toThrow(/prefix/);
  });

  it('rejects duplicates, empty RHS, and bad notation — loudly, with the mode', () => {
    expect(() => compileKeymap({ normal: { H: '' } })).toThrow(/empty RHS/);
    expect(() => compileKeymap({ visual: { '<Nope>': 'x' } })).toThrow(/unknown key/);
  });
});
