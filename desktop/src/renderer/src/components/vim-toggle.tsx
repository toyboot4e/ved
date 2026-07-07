import { editorStyles as styles } from '@ved/editor';
import type React from 'react';
import { preserveFocus } from '../focus';
import { useVimStore } from '../vim';

/** The Vim-mode toolbar group: an on/off toggle plus — while on — the live
 *  mode chip (NORMAL/INSERT/VISUAL, fed by the extension's onModeChange), the
 *  `/`?`?` search command line as it is typed, and a macro-recording chip. */
export const VimToggle = (): React.JSX.Element => {
  const enabled = useVimStore((s) => s.enabled);
  const mode = useVimStore((s) => s.mode);
  const commandLine = useVimStore((s) => s.commandLine);
  const macroRecording = useVimStore((s) => s.macroRecording);
  const toggle = useVimStore((s) => s.toggle);
  return (
    <fieldset className={styles.toolbarGroup} aria-label='Vim mode' onMouseDown={preserveFocus}>
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
      {enabled && commandLine !== null && (
        <span id='vim-command-line' className={styles.toolbarGroupLabel} title='Vim search'>
          {commandLine}
        </span>
      )}
      {enabled && macroRecording !== null && (
        <span id='vim-macro-recording' className={styles.toolbarGroupLabel} title='Recording a macro'>
          {`recording @${macroRecording}`}
        </span>
      )}
    </fieldset>
  );
};
