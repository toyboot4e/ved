// Terminal (xterm) theme, derived from the SAME `--ved-*` tokens as the rest
// of the chrome (main.scss) — read off <html> at call time, so any palette,
// present or future, colors the terminal without a parallel table here. The
// store writes `data-theme` synchronously with set() (theme.ts), so callers
// in React effects never read stale tokens. xterm's css parser accepts the
// token values as-is (hex and rgb()/rgba()).
import type { ITheme } from '@xterm/xterm';

export const shellTheme = (): ITheme => {
  const tokens = getComputedStyle(document.documentElement);
  const token = (name: string): string => tokens.getPropertyValue(name).trim();
  return {
    background: token('--ved-bg'),
    foreground: token('--ved-fg'),
    cursor: token('--ved-caret'),
    cursorAccent: token('--ved-bg'),
    selectionBackground: token('--ved-selection'),
    black: token('--ved-term-black'),
    red: token('--ved-term-red'),
    green: token('--ved-term-green'),
    yellow: token('--ved-term-yellow'),
    blue: token('--ved-term-blue'),
    magenta: token('--ved-term-magenta'),
    cyan: token('--ved-term-cyan'),
    white: token('--ved-term-white'),
    brightBlack: token('--ved-term-bright-black'),
    brightRed: token('--ved-term-bright-red'),
    brightGreen: token('--ved-term-bright-green'),
    brightYellow: token('--ved-term-bright-yellow'),
    brightBlue: token('--ved-term-bright-blue'),
    brightMagenta: token('--ved-term-bright-magenta'),
    brightCyan: token('--ved-term-bright-cyan'),
    brightWhite: token('--ved-term-bright-white'),
  };
};
