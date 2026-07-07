import { clsx } from 'clsx';
import type React from 'react';
import { type BufferId, isDirty } from '../buffers';
import { dispatchBuffers, useBuffersStore } from '../buffers-store';
import { fileName } from '../file-commands';
import styles from './tab-bar.module.scss';

export type TabBarProps = {
  /** The ACTIVE buffer's live dirtiness — tracked in app.tsx outside the
   *  store (the store's committed text lags during editing; buffers-store.ts). */
  readonly activeDirty: boolean;
  /** Closing goes through app.tsx: it owns the dirty-discard confirmation. */
  readonly onClose: (id: BufferId) => void;
};

export const TabBar = ({ activeDirty, onClose }: TabBarProps): React.JSX.Element => {
  const tabs = useBuffersStore((s) => s.buffers);
  const activeId = useBuffersStore((s) => s.activeId);
  const select = (id: BufferId): void => {
    if (id !== activeId) dispatchBuffers({ type: 'setActive', id });
  };
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
              select(tab.id);
            }
          }}
        >
          <span className={styles.dirtyDot} data-visible={tab.id === activeId ? activeDirty : isDirty(tab)}>
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
