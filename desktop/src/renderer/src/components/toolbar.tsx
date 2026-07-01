import { AppearPolicy, editorStyles as styles, WritingMode } from '@ved/editor';
import type React from 'react';
import { HorizontalIcon, VerticalColumnsIcon, VerticalIcon, VerticalRowsIcon } from './icons/WritingModeIcons';
import { ViewConfigControls } from './view-config-controls';

/** Properties of {@link Toolbar}. */
export type ToolbarProps = {
  readonly writingMode: WritingMode;
  readonly setWritingMode: (_: WritingMode) => void;
  readonly appearPolicy: AppearPolicy;
  readonly setAppearPolicy: (_: AppearPolicy) => void;
};

const writingModeItems: {
  mode: WritingMode;
  label: string;
  title: string;
  Icon: React.ComponentType<{ className?: string }>;
}[] = [
  { mode: WritingMode.Horizontal, label: 'Horizontal', title: 'Horizontal writing', Icon: HorizontalIcon },
  {
    mode: WritingMode.Vertical,
    label: 'Vertical',
    title: 'Vertical writing — one continuous flow, both axes scroll',
    Icon: VerticalIcon,
  },
  {
    mode: WritingMode.VerticalColumns,
    label: 'Vertical Columns',
    title: 'Vertical writing — pages stack downward (dankumi, vertical scroll)',
    Icon: VerticalColumnsIcon,
  },
  {
    mode: WritingMode.VerticalRows,
    label: 'Vertical Rows',
    title: 'Vertical writing — pages tile leftward like a book (dankumi, horizontal scroll)',
    Icon: VerticalRowsIcon,
  },
];

const appearPolicyItems: { policy: AppearPolicy; label: string; title: string }[] = [
  { policy: AppearPolicy.Plain, label: 'Plain', title: 'Plain text with ruby syntax (Ctrl+1)' },
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
      <fieldset className={styles.toolbarGroup} aria-label='Writing mode' onMouseDown={keepEditorFocus}>
        <span className={styles.toolbarGroupLabel} aria-hidden='true' title='Text direction and layout'>
          Writing
        </span>
        {writingModeItems.map(({ mode, label, title, Icon }) => (
          <button
            key={mode}
            type='button'
            className={styles.toolbarIconButton}
            aria-pressed={writingMode === mode}
            aria-label={label}
            title={title}
            onClick={() => setWritingMode(mode)}
          >
            <Icon />
          </button>
        ))}
      </fieldset>
      <fieldset className={styles.toolbarGroup} aria-label='Ruby display' onMouseDown={keepEditorFocus}>
        <span
          className={styles.toolbarGroupLabel}
          aria-hidden='true'
          title='Where ruby annotations show as raw |…(…) syntax'
        >
          Ruby
        </span>
        {appearPolicyItems.map(({ policy, label, title }) => (
          <button
            key={policy}
            type='button'
            className={styles.toolbarButton}
            aria-pressed={appearPolicy === policy}
            title={title}
            onClick={() => setAppearPolicy(policy)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <ViewConfigControls />
    </div>
  );
};
