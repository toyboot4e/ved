// State behind the extension UI surfaces (shared/extension-api.ts UiHandle):
// status bar items, bottom-docked panels, and the modal quick pick. Stores
// only — the components live in components/extension-ui.tsx, and the
// id-binding/disposal wrapper in extension-host.ts. Everything an extension
// contributes carries its owner id (`data-ved-ext` in the DOM).
import { create } from 'zustand';
import { type RankedLabel, rankLabels } from './extension-model';
import { focusEditor } from './focus';

let nextKey = 0;

// ---------------------------------------------------------------------------
// Status bar items (rendered by StatusItems in the editor footer).

export type StatusItemState = {
  readonly key: number;
  readonly owner: string;
  readonly text: string;
  readonly title: string | null;
  /** Already guarded by the host (a throwing handler reports, not crashes). */
  readonly onClick: (() => void) | null;
};

export const useStatusItemsStore = create<{ readonly items: readonly StatusItemState[] }>()(() => ({ items: [] }));

export const addStatusItem = (
  owner: string,
  init: { readonly text: string; readonly title?: string; readonly onClick?: (() => void) | undefined },
): { update: (fields: { readonly text?: string; readonly title?: string }) => void; remove: () => void } => {
  const key = nextKey++;
  const item: StatusItemState = {
    key,
    owner,
    text: init.text,
    title: init.title ?? null,
    onClick: init.onClick ?? null,
  };
  useStatusItemsStore.setState((s) => ({ items: [...s.items, item] }));
  return {
    update: (fields) =>
      useStatusItemsStore.setState((s) => ({
        items: s.items.map((it) =>
          it.key === key ? { ...it, text: fields.text ?? it.text, title: fields.title ?? it.title } : it,
        ),
      })),
    remove: () => useStatusItemsStore.setState((s) => ({ items: s.items.filter((it) => it.key !== key) })),
  };
};

// ---------------------------------------------------------------------------
// Bottom-docked panels (rendered by ExtensionPanels above the shell panel).

export type PanelState = {
  readonly key: number;
  readonly owner: string;
  readonly title: string;
  /** The extension-owned body element — alive across show/hide. */
  readonly element: HTMLElement;
  readonly visible: boolean;
};

export const useExtensionPanelsStore = create<{ readonly panels: readonly PanelState[] }>()(() => ({ panels: [] }));

const setPanelVisible = (key: number, visible: boolean): void =>
  useExtensionPanelsStore.setState((s) => ({
    panels: s.panels.map((p) => (p.key === key ? { ...p, visible } : p)),
  }));

export const addExtensionPanel = (
  owner: string,
  title: string,
): { element: HTMLElement; show: () => void; hide: () => void; remove: () => void } => {
  const key = nextKey++;
  const element = document.createElement('div');
  element.dataset.vedExt = owner;
  useExtensionPanelsStore.setState((s) => ({ panels: [...s.panels, { key, owner, title, element, visible: false }] }));
  return {
    element,
    show: () => setPanelVisible(key, true),
    hide: () => setPanelVisible(key, false),
    remove: () => useExtensionPanelsStore.setState((s) => ({ panels: s.panels.filter((p) => p.key !== key) })),
  };
};

/** The panel-header close button (components/extension-ui.tsx). */
export const hideExtensionPanel = setPanelVisible;

// ---------------------------------------------------------------------------
// The modal quick pick: ONE at a time; a new one preempts (resolving the
// first with null), like any modal takeover. The resolver lives outside the
// store — a Promise resolver is not render state.

type PickerStore = {
  readonly open: boolean;
  readonly owner: string | null;
  readonly placeholder: string;
  readonly labels: readonly string[];
  readonly query: string;
  readonly matches: readonly RankedLabel[];
  readonly selected: number;
};

const PICKER_CLOSED = {
  open: false,
  owner: null,
  placeholder: '',
  labels: [],
  query: '',
  matches: [],
  selected: 0,
} as const;

export const useExtensionPickerStore = create<PickerStore>()(() => PICKER_CLOSED);

let pickerResolver: ((index: number | null) => void) | null = null;

/** Open the picker; resolves the chosen ORIGINAL index, or null on dismissal. */
export const openExtensionPicker = (
  owner: string,
  labels: readonly string[],
  placeholder = '',
): Promise<number | null> => {
  pickerResolver?.(null);
  return new Promise((resolve) => {
    pickerResolver = resolve;
    useExtensionPickerStore.setState({
      open: true,
      owner,
      placeholder,
      labels,
      query: '',
      matches: rankLabels(labels, ''),
      selected: 0,
    });
  });
};

/** Close the picker, resolving its promise (`null` = dismissed) and handing
 *  focus back to the editor (the overlay input owned it). */
export const settleExtensionPicker = (index: number | null): void => {
  const resolve = pickerResolver;
  pickerResolver = null;
  useExtensionPickerStore.setState(PICKER_CLOSED);
  resolve?.(index);
  focusEditor();
};

export const setExtensionPickerQuery = (query: string): void =>
  useExtensionPickerStore.setState((s) => ({ query, matches: rankLabels(s.labels, query), selected: 0 }));

export const moveExtensionPickerSelection = (delta: 1 | -1): void =>
  useExtensionPickerStore.setState((s) =>
    s.matches.length === 0 ? {} : { selected: (s.selected + delta + s.matches.length) % s.matches.length },
  );

export const setExtensionPickerSelected = (selected: number): void => useExtensionPickerStore.setState({ selected });
