import {
  AppearPolicy,
  editorStyles as styles,
  type WritingOrientation,
  type WritingPaging,
  writingModeFor,
  writingOrientation,
  writingPaging,
} from '@ved/editor';
import type React from 'react';
import { useAppearPolicyStore } from '../appear-policy';
import { preserveFocus } from '../focus';
import { useWorkspaceStore } from '../workspace';
import { useWritingModeStore } from '../writing-mode';
import {
  HorizontalIcon,
  PagingColumnsIcon,
  PagingContinuousIcon,
  PagingRowsIcon,
  VerticalIcon,
} from './icons/WritingModeIcons';
import { InvisiblesControls } from './invisibles-controls';
import { ThemeToggle } from './theme-toggle';
import { ViewConfigControls } from './view-config-controls';
import { VimToggle } from './vim-toggle';

// The writing mode is a COMBINATION of two orthogonal axes (writing-mode.ts),
// so the toolbar renders one button group per axis: 2 orientations × 3
// pagings = 6 modes behind 5 buttons. Each button keeps the OTHER axis as it
// is.
const orientationItems: {
  orientation: WritingOrientation;
  label: string;
  title: string;
  Icon: React.ComponentType<{ className?: string }>;
}[] = [
  { orientation: 'horizontal', label: 'Horizontal', title: 'Horizontal writing', Icon: HorizontalIcon },
  { orientation: 'vertical', label: 'Vertical', title: 'Vertical writing (tategaki)', Icon: VerticalIcon },
];

const pagingItems: {
  paging: WritingPaging;
  label: string;
  title: (orientation: WritingOrientation) => string;
  Icon: React.ComponentType<{ className?: string; orientation: WritingOrientation }>;
}[] = [
  {
    paging: 'continuous',
    label: 'Continuous',
    title: () => 'One continuous flow, no pages',
    Icon: PagingContinuousIcon,
  },
  {
    paging: 'columns',
    label: 'Columns',
    title: (o) =>
      o === 'vertical' ? 'Pages stack downward (dankumi, vertical scroll)' : 'Pages tile rightward (horizontal scroll)',
    Icon: PagingColumnsIcon,
  },
  {
    paging: 'rows',
    label: 'Rows',
    title: (o) =>
      o === 'vertical'
        ? 'Pages tile leftward like a book (dankumi, horizontal scroll)'
        : 'Pages stack downward like a manuscript (vertical scroll)',
    Icon: PagingRowsIcon,
  },
];

const appearPolicyItems: { policy: AppearPolicy; label: string; title: string }[] = [
  { policy: AppearPolicy.Plain, label: 'Plain', title: 'Plain text with ruby syntax (Ctrl+1)' },
  {
    policy: AppearPolicy.ByParagraph,
    label: 'Paragraph',
    title: 'Expand ruby syntax in the cursor paragraph (Ctrl+2)',
  },
  {
    policy: AppearPolicy.ByCharacter,
    label: 'Character',
    title: 'Expand ruby syntax under the cursor (Ctrl+3, Ctrl+/)',
  },
  { policy: AppearPolicy.Rich, label: 'Rich', title: 'Always render ruby (Ctrl+4, Ctrl+/)' },
];

export const Toolbar = (): React.JSX.Element => {
  const writingMode = useWritingModeStore((s) => s.writingMode);
  const setWritingMode = useWritingModeStore((s) => s.set);
  const appearPolicy = useAppearPolicyStore((s) => s.appearPolicy);
  const setAppearPolicy = useAppearPolicyStore((s) => s.set);
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar);
  return (
    <div className={styles.toolbar}>
      <fieldset className={styles.toolbarGroup} aria-label='Sidebar' onMouseDown={preserveFocus}>
        <button
          type='button'
          className={styles.toolbarButton}
          aria-pressed={sidebarOpen}
          aria-label='Toggle sidebar'
          title='File browser sidebar (Ctrl+B)'
          onClick={toggleSidebar}
        >
          ☰
        </button>
      </fieldset>
      <fieldset className={styles.toolbarGroup} aria-label='Writing mode' onMouseDown={preserveFocus}>
        <span className={styles.toolbarGroupLabel} aria-hidden='true' title='Text direction'>
          Writing
        </span>
        {orientationItems.map(({ orientation, label, title, Icon }) => (
          <button
            key={orientation}
            type='button'
            className={styles.toolbarIconButton}
            aria-pressed={writingOrientation(writingMode) === orientation}
            aria-label={label}
            title={title}
            onClick={() => setWritingMode(writingModeFor(orientation, writingPaging(writingMode)))}
          >
            <Icon />
          </button>
        ))}
      </fieldset>
      <fieldset className={styles.toolbarGroup} aria-label='Paging' onMouseDown={preserveFocus}>
        <span className={styles.toolbarGroupLabel} aria-hidden='true' title='How the document breaks into pages'>
          Pages
        </span>
        {pagingItems.map(({ paging, label, title, Icon }) => (
          <button
            key={paging}
            type='button'
            className={styles.toolbarIconButton}
            aria-pressed={writingPaging(writingMode) === paging}
            aria-label={label}
            title={title(writingOrientation(writingMode))}
            onClick={() => setWritingMode(writingModeFor(writingOrientation(writingMode), paging))}
          >
            <Icon orientation={writingOrientation(writingMode)} />
          </button>
        ))}
      </fieldset>
      <fieldset className={styles.toolbarGroup} aria-label='Ruby display' onMouseDown={preserveFocus}>
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
      <InvisiblesControls />
      <ViewConfigControls writingMode={writingMode} />
      <VimToggle />
      <ThemeToggle />
    </div>
  );
};
