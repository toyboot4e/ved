import { editorStyles as styles } from '@ved/editor';
import type React from 'react';
import { type Invisibles, useInvisiblesStore } from '../invisibles';

// Invisibles toggles: a toolbar group of press-to-toggle buttons, styled like
// the writing-mode/ruby button rows. Writes the invisibles store; app.tsx passes
// it to VedEditor, which renders the markers as view-only decorations (copy stays
// plain). Debug-adjacent, so it sits next to the view-config controls.

const items: { key: keyof Invisibles; label: string; title: string }[] = [
  { key: 'newline', label: '改行', title: 'Show a ↵ marker at each line end (newline)' },
  { key: 'whitespace', label: '空白', title: 'Show markers for spaces (·), full-width spaces (□) and tabs (→)' },
];

/** Prevent toolbar clicks from stealing focus (and the selection) from the editor. */
const keepEditorFocus: React.MouseEventHandler = (event) => {
  event.preventDefault();
};

export const InvisiblesControls = (): React.JSX.Element => {
  const invisibles = useInvisiblesStore((s) => s.invisibles);
  const toggle = useInvisiblesStore((s) => s.toggle);
  return (
    <fieldset className={styles.toolbarGroup} aria-label='Invisibles' onMouseDown={keepEditorFocus}>
      <span className={styles.toolbarGroupLabel} aria-hidden='true' title='Show newline / whitespace markers'>
        Marks
      </span>
      {items.map(({ key, label, title }) => (
        <button
          key={key}
          type='button'
          className={styles.toolbarButton}
          aria-pressed={invisibles[key]}
          title={title}
          onClick={() => toggle(key)}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
};
