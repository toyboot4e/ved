// The settings popover's open state (toolbar gear / `view.toggleSettings`,
// default Mod+,). The panel hosts the runtime configuration controls that
// used to sit inline on the toolbar row (view config, invisibles); the
// controls write their own stores, so this store is UI state only — nothing
// here persists (the Vim model: `init.ts` is the durable config). Non-modal:
// the editor stays interactive under it, and closing hands focus back to the
// editor exactly like the search bar does.
import { create } from 'zustand';
import { focusEditor } from './focus';

type SettingsPanelStore = {
  readonly open: boolean;
};

export const useSettingsPanelStore = create<SettingsPanelStore>(() => ({ open: false }));

export const openSettingsPanel = (): void => useSettingsPanelStore.setState({ open: true });

export const closeSettingsPanel = (): void => {
  if (!useSettingsPanelStore.getState().open) return;
  useSettingsPanelStore.setState({ open: false });
  focusEditor();
};

export const toggleSettingsPanel = (): void =>
  useSettingsPanelStore.getState().open ? closeSettingsPanel() : openSettingsPanel();
