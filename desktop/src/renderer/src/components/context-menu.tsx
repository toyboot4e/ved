// A minimal hand-rolled context menu: fixed at the pointer (clamped to the
// window), a transparent backdrop swallows the next click anywhere else, and
// Esc closes. Selecting an item closes first, then runs the action.
import type React from 'react';
import { useEffect } from 'react';
import { preserveFocus } from '../focus';
import styles from './context-menu.module.scss';

export type ContextMenuItem = {
  readonly label: string;
  readonly onSelect: () => void;
};

export type ContextMenuProps = {
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  readonly onClose: () => void;
};

/** Approximate menu box, for clamping only (real size varies with labels). */
const CLAMP_WIDTH = 200;
const ITEM_HEIGHT = 28;

export const ContextMenu = ({ x, y, items, onClose }: ContextMenuProps): React.JSX.Element => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const left = Math.max(0, Math.min(x, window.innerWidth - CLAMP_WIDTH));
  const top = Math.max(0, Math.min(y, window.innerHeight - items.length * ITEM_HEIGHT - 10));
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click-catcher, not a control — the menu itself is the widget */}
      <div
        className={styles.backdrop}
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className={styles.menu} role='menu' style={{ left, top }}>
        {items.map((item) => (
          <button
            key={item.label}
            type='button'
            role='menuitem'
            className={styles.item}
            onMouseDown={preserveFocus}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
};
