// Extension UI surfaces (shared/extension-api.ts UiHandle): status bar
// items, bottom-docked panels, and the modal quick pick. Pure UI over the
// extension-ui.ts stores; the quick pick borrows the quick-open overlay's
// styling so the two pickers read as one family.
import { clsx } from 'clsx';
import type React from 'react';
import { useEffect, useRef } from 'react';
import {
  hideExtensionPanel,
  moveExtensionPickerSelection,
  type PanelState,
  setExtensionPickerQuery,
  setExtensionPickerSelected,
  settleExtensionPicker,
  useExtensionPanelsStore,
  useExtensionPickerStore,
  useStatusItemsStore,
} from '../extension-ui';
import { isComposingEvent } from '../ime';
import styles from './extension-ui.module.scss';
import quickOpenStyles from './quick-open.module.scss';

// ---------------------------------------------------------------------------
// Status bar items (inside the editor footer; the host div carries
// styles.footerHost so these dock at its right edge).

export const StatusItems = (): React.JSX.Element | null => {
  const items = useStatusItemsStore((s) => s.items);
  if (items.length === 0) return null;
  return (
    <div id='extension-status-items' className={styles.statusItems}>
      {items.map((item) =>
        item.onClick !== null ? (
          <button
            key={item.key}
            type='button'
            className={styles.statusItem}
            title={item.title ?? undefined}
            data-ved-ext={item.owner}
            onClick={item.onClick}
          >
            {item.text}
          </button>
        ) : (
          <span key={item.key} className={styles.statusItem} title={item.title ?? undefined} data-ved-ext={item.owner}>
            {item.text}
          </span>
        ),
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Bottom-docked panels, one section per VISIBLE panel (hidden panels keep
// their extension-owned element alive off-DOM).

const PanelHost = ({ panel }: { readonly panel: PanelState }): React.JSX.Element => {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Adopt the extension-owned element into the panel body. On unmount the
  // element is detached, NOT destroyed — the extension keeps it (and its
  // content) for the next show().
  useEffect(() => {
    bodyRef.current?.appendChild(panel.element);
    return () => panel.element.remove();
  }, [panel.element]);

  return (
    <section className={styles.panel} aria-label={panel.title} data-ved-ext={panel.owner}>
      <div className={styles.panelHeader}>
        <span>{panel.title}</span>
        <button
          type='button'
          className={styles.panelClose}
          aria-label={`Close ${panel.title}`}
          onClick={() => hideExtensionPanel(panel.key, false)}
        >
          ✕
        </button>
      </div>
      <div ref={bodyRef} className={styles.panelBody} />
    </section>
  );
};

export const ExtensionPanels = (): React.JSX.Element | null => {
  const panels = useExtensionPanelsStore((s) => s.panels);
  const visible = panels.filter((p) => p.visible);
  if (visible.length === 0) return null;
  return (
    <>
      {visible.map((panel) => (
        <PanelHost key={panel.key} panel={panel} />
      ))}
    </>
  );
};

// ---------------------------------------------------------------------------
// The modal quick pick — the quick-open overlay's little sibling: same
// backdrop/panel/list styling, no modes, no preview. The input owns focus
// while open; settling hands it back to the editor (extension-ui.ts).

const MatchedLabel = ({
  label,
  matched,
}: {
  readonly label: string;
  readonly matched: readonly number[];
}): React.JSX.Element => {
  if (matched.length === 0) return <>{label}</>;
  const hit = new Set(matched);
  return (
    <>
      {Array.from(label, (ch, i) =>
        hit.has(i) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static, never-reordered per-character render
          <mark key={i} className={quickOpenStyles.match}>
            {ch}
          </mark>
        ) : (
          ch
        ),
      )}
    </>
  );
};

export const ExtensionQuickPick = (): React.JSX.Element => {
  const placeholder = useExtensionPickerStore((s) => s.placeholder);
  const query = useExtensionPickerStore((s) => s.query);
  const matches = useExtensionPickerStore((s) => s.matches);
  const selected = useExtensionPickerStore((s) => s.selected);
  const owner = useExtensionPickerStore((s) => s.owner);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on selection change
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, matches]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (isComposingEvent(event.nativeEvent)) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveExtensionPickerSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveExtensionPickerSelection(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const s = useExtensionPickerStore.getState();
      settleExtensionPicker(s.matches[s.selected]?.index ?? null);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      settleExtensionPicker(null);
    }
  };

  return (
    // The backdrop (role=dialog) is a plain dismiss target; Esc settles via the input.
    <div
      className={quickOpenStyles.overlay}
      role='dialog'
      aria-label='Quick pick'
      aria-modal='true'
      data-ved-ext={owner ?? undefined}
      onMouseDown={() => settleExtensionPicker(null)}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops backdrop dismissal for clicks inside the panel */}
      <div className={quickOpenStyles.panel} onMouseDown={(e) => e.stopPropagation()}>
        <div className={quickOpenStyles.inputRow}>
          <input
            id='extension-quick-pick-input'
            ref={inputRef}
            className={quickOpenStyles.input}
            type='text'
            placeholder={placeholder}
            spellCheck={false}
            value={query}
            onChange={(event) => setExtensionPickerQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div ref={listRef} className={quickOpenStyles.list} role='listbox' aria-label='Choices'>
          {matches.length === 0 ? (
            <div className={quickOpenStyles.emptyNote}>一致する項目がありません</div>
          ) : (
            matches.map((match, i) => (
              // biome-ignore lint/a11y/useFocusableInteractive: a listbox option is not focusable — the input holds focus
              <div
                key={match.index}
                role='option'
                aria-selected={i === selected}
                className={clsx(quickOpenStyles.row, i === selected && quickOpenStyles.rowSelected)}
                onMouseMove={() => i !== selected && setExtensionPickerSelected(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  settleExtensionPicker(match.index);
                }}
              >
                <MatchedLabel label={match.label} matched={match.matched} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
