import { editorStyles as styles, type WritingMode } from '@ved/editor';
import React from 'react';
import { formatAppChord, useAppKeymapStore } from '../app-keymap';
import { preserveFocus } from '../focus';
import { appChordFor } from '../keymap';
import { closeSettingsPanel, toggleSettingsPanel, useSettingsPanelStore } from '../settings-panel';
import { GearIcon } from './icons/SettingsIcons';
import { InvisiblesControls } from './invisibles-controls';
import panelStyles from './settings-panel.module.scss';
import { ViewConfigControls } from './view-config-controls';

// The settings gear + its popover (settings-panel.ts store): the runtime
// configuration controls moved off the toolbar row. Non-modal — Esc (the
// global dispatcher), an outside click, the gear, or the `view.toggleSettings`
// chord close it. The gear's tooltip renders the EFFECTIVE chord, so an
// `appKeybindings` rebind from init.ts shows itself.

export const SettingsControls = ({ writingMode }: { readonly writingMode: WritingMode }): React.JSX.Element => {
  const open = useSettingsPanelStore((s) => s.open);
  const overrides = useAppKeymapStore((s) => s.overrides);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Outside click closes. `pointerdown` (not click) so a drag that starts
  // outside dismisses immediately; anything inside the anchor — the gear
  // included, whose own onClick then toggles — stays.
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !containerRef.current?.contains(event.target)) closeSettingsPanel();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const chord = formatAppChord(appChordFor('view.toggleSettings', overrides), window.ved.platform === 'darwin');
  return (
    <div ref={containerRef} className={panelStyles.anchor}>
      <fieldset className={styles.toolbarGroup} aria-label='Settings' onMouseDown={preserveFocus}>
        <button
          type='button'
          className={styles.toolbarIconButton}
          aria-label='Settings'
          aria-haspopup='dialog'
          aria-expanded={open}
          title={`設定 (${chord})`}
          onClick={toggleSettingsPanel}
        >
          <GearIcon />
        </button>
      </fieldset>
      {open && (
        <div role='dialog' aria-label='設定' className={panelStyles.panel}>
          <ViewConfigControls writingMode={writingMode} />
          <InvisiblesControls />
        </div>
      )}
    </div>
  );
};
