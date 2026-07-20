// User-configurable app chords (editor UI plan "One keymap registry" — the
// registry is keyed by command name from day one exactly so the config file
// can rebind it). The defaults stay in keymap.ts's APP_KEYMAP; `init.ts`
// overrides individual commands via
// `ctx.settings.apply({ appKeybindings: { 'view.toggleSettings': 'mod+shift+,' } })`
// (settings.ts validates and writes this store). An override REPLACES the
// command's default chord; like every settings store the overrides are
// baseline-tracked, so a re-evaluation with the line removed reverts them.
import { create } from 'zustand';
import type { AppCommand, Chord } from './keymap';

export type AppKeymapOverrides = Partial<Readonly<Record<AppCommand, Chord>>>;

type AppKeymapStore = {
  readonly overrides: AppKeymapOverrides;
};

export const useAppKeymapStore = create<AppKeymapStore>(() => ({ overrides: {} }));

/**
 * Parse a user chord spec (`'mod+,'`, `'ctrl+shift+tab'`) into an app
 * `Chord`, or `null` when malformed. Case-insensitive. The vocabulary is the
 * app table's: exactly one of `mod`/`ctrl` (the platform modifier vs.
 * literal-Ctrl-on-both), optional `shift`, one key. Alt/super chords are not
 * app chords (matchChord rejects Alt) — bind those in the editor's table.
 */
export const parseAppChord = (spec: string): Chord | null => {
  const parts = spec.split('+').map((part) => part.trim().toLowerCase());
  // A trailing '+' names the '+' key itself ('mod++' → ['mod', '', '']).
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') {
    parts.splice(parts.length - 2, 2, '+');
  }
  const key = parts.pop();
  if (key === undefined || key === '' || key === 'mod' || key === 'ctrl' || key === 'shift') return null;
  let mod: Chord['mod'] | null = null;
  let shift = false;
  for (const part of parts) {
    if (part === 'shift' && !shift) shift = true;
    else if ((part === 'mod' || part === 'ctrl') && mod === null) mod = part;
    else return null; // unknown/duplicate modifier — alt and super included
  }
  if (mod === null) return null;
  return { key, mod, ...(shift ? { shift: true } : {}) };
};

/** Render a chord for a tooltip (`'Ctrl+Shift+,'`; `mod` shows as Cmd on
 *  macOS). Named keys are capitalized (`'tab'` → `'Tab'`). */
export const formatAppChord = (chord: Chord, isDarwin: boolean): string => {
  const mod = chord.mod === 'mod' && isDarwin ? 'Cmd' : 'Ctrl';
  const key = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key[0]!.toUpperCase() + chord.key.slice(1);
  return `${mod}${chord.shift ? '+Shift' : ''}+${key}`;
};
