import { editorStyles as styles } from '@ved/editor';
import type React from 'react';
import { preserveFocus } from '../focus';
import { type Theme, useThemeStore } from '../theme';
import { MoonIcon, SunIcon } from './icons/ThemeIcons';

// Theme toggle: one icon button that flips Light ⇄ Dark. The icon shows the
// CURRENT theme (app.tsx applies it to <html data-theme>); the launch default is
// the OS preference (theme.ts). Styled like the writing-mode icon buttons.

const face: Record<Theme, { Icon: React.ComponentType<{ className?: string }>; label: string }> = {
  light: { Icon: SunIcon, label: 'Light' },
  dark: { Icon: MoonIcon, label: 'Dark' },
};

export const ThemeToggle = (): React.JSX.Element => {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const { Icon, label } = face[theme];
  const other = theme === 'dark' ? 'Light' : 'Dark';
  return (
    <fieldset className={styles.toolbarGroup} aria-label='Theme' onMouseDown={preserveFocus}>
      <button
        type='button'
        className={styles.toolbarIconButton}
        aria-label={`Theme: ${label}`}
        title={`Theme: ${label} — click to switch to ${other}`}
        onClick={toggle}
      >
        <Icon />
      </button>
    </fieldset>
  );
};
