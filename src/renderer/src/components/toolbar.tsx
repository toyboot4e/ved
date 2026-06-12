import type React from 'react';
import { AppearPolicy, WritingMode } from './editor';
import styles from './editor.module.scss';

/** Properties of {@link Toolbar}. */
export type ToolbarProps = {
  readonly writingMode: WritingMode;
  readonly setWritingMode: (_: WritingMode) => void;
  readonly appearPolicy: AppearPolicy;
  readonly setAppearPolicy: (_: AppearPolicy) => void;
};

const writingModeItems: { mode: WritingMode; label: string; title: string }[] = [
  { mode: WritingMode.Horizontal, label: 'Horizontal', title: 'Horizontal writing' },
  { mode: WritingMode.Vertical, label: 'Vertical', title: 'Vertical writing, one continuous flow' },
  { mode: WritingMode.VerticalColumns, label: 'Columns', title: 'Vertical writing, multi-column layout' },
];

const appearPolicyItems: { policy: AppearPolicy; label: string; title: string }[] = [
  { policy: AppearPolicy.ShowAll, label: 'Plain', title: 'Plain text with ruby syntax (Ctrl+1)' },
  {
    policy: AppearPolicy.ByParagraph,
    label: 'Paragraph',
    title: 'Expand ruby syntax in the cursor paragraph (Ctrl+2)',
  },
  { policy: AppearPolicy.ByCharacter, label: 'Character', title: 'Expand ruby syntax under the cursor (Ctrl+3)' },
  { policy: AppearPolicy.Rich, label: 'Rich', title: 'Always render ruby (Ctrl+4)' },
];

/** Prevent toolbar clicks from stealing focus (and the selection) from the editor. */
const keepEditorFocus: React.MouseEventHandler = (event) => {
  event.preventDefault();
};

export const Toolbar = ({
  writingMode,
  setWritingMode,
  appearPolicy,
  setAppearPolicy,
}: ToolbarProps): React.JSX.Element => {
  return (
    <div className={styles.toolbar}>
      <fieldset className={styles.toolbarGroup} aria-label='Writing mode'>
        {writingModeItems.map(({ mode, label, title }) => (
          <button
            key={mode}
            type='button'
            className={styles.toolbarButton}
            aria-pressed={writingMode === mode}
            title={title}
            onMouseDown={keepEditorFocus}
            onClick={() => setWritingMode(mode)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <fieldset className={styles.toolbarGroup} aria-label='View mode'>
        {appearPolicyItems.map(({ policy, label, title }) => (
          <button
            key={policy}
            type='button'
            className={styles.toolbarButton}
            aria-pressed={appearPolicy === policy}
            title={title}
            onMouseDown={keepEditorFocus}
            onClick={() => setAppearPolicy(policy)}
          >
            {label}
          </button>
        ))}
      </fieldset>
    </div>
  );
};
