import { clsx } from 'clsx';
import type React from 'react';
import type { BufferId } from '../buffers';
import { fileName } from '../file-commands';
import styles from './tab-bar.module.scss';

export type TabDescriptor = {
  readonly id: BufferId;
  readonly path: string | null;
  readonly dirty: boolean;
};

export type TabBarProps = {
  readonly tabs: readonly TabDescriptor[];
  readonly activeId: BufferId;
  readonly onSelect: (id: BufferId) => void;
  readonly onClose: (id: BufferId) => void;
};

export const TabBar = ({ tabs, activeId, onSelect, onClose }: TabBarProps): React.JSX.Element => {
  return (
    <div className={styles.tabBar} role='tablist'>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role='tab'
          tabIndex={tab.id === activeId ? 0 : -1}
          aria-selected={tab.id === activeId}
          className={clsx(styles.tab, tab.id === activeId && styles.active)}
          title={tab.path ?? '無題'}
          onMouseDown={(e) => {
            // Middle-click closes; left-click selects (close button has its own handler)
            if (e.button === 1) {
              e.preventDefault();
              onClose(tab.id);
            } else if (e.button === 0) {
              onSelect(tab.id);
            }
          }}
        >
          <span className={styles.dirtyDot} data-visible={tab.dirty}>
            ●
          </span>
          <span className={styles.tabLabel}>{fileName(tab.path)}</span>
          <button
            type='button'
            className={styles.closeButton}
            aria-label={`Close ${fileName(tab.path)}`}
            onMouseDown={(e) => {
              e.stopPropagation(); // don't trigger select
            }}
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
};
