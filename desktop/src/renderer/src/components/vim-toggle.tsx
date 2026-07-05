import { editorStyles as styles } from '@ved/editor';
import type React from 'react';
import { useVimStore } from '../vim';

/** Prevent the click from stealing focus (and the selection) from the editor. */
const keepEditorFocus: React.MouseEventHandler = (event) => {
  event.preventDefault();
};

/** The Vim-mode toolbar group: an on/off toggle plus — while on — the live
 *  mode chip (NORMAL/INSERT/VISUAL, fed by the extension's onModeChange). */
export const VimToggle = (): React.JSX.Element => {
  const enabled = useVimStore((s) => s.enabled);
  const mode = useVimStore((s) => s.mode);
  const toggle = useVimStore((s) => s.toggle);
  return (
    <fieldset className={styles.toolbarGroup} aria-label='Vim mode' onMouseDown={keepEditorFocus}>
      <button
        type='button'
        className={styles.toolbarButton}
        aria-pressed={enabled}
        aria-label='Toggle Vim mode'
        title='Vim-like modal editing (@ved/vim extension)'
        onClick={toggle}
      >
        Vim
      </button>
      {enabled && (
        <span id='vim-mode' className={styles.toolbarGroupLabel} title='Current Vim mode'>
          {mode.toUpperCase()}
        </span>
      )}
    </fieldset>
  );
};
