// User settings (docs/editor-ui-plan.md Phase 4): the `ctx.settings.apply`
// mapping from `VedSettings` field names onto the shell's stores, and the
// LAUNCH BASELINE whole-config re-evaluation resets to (extension-host.ts).
// Configuration IS code — `init.ts` applies settings; changes made at
// runtime through the UI are ephemeral by design (the Vim model), so this
// module never persists anything. Invalid fields report and are skipped;
// numbers ride the stores' own clamps, so a garbage value can never render
// a broken layout.
import { AppearPolicy, type Invisibles, WritingMode } from '@ved/editor';
import type { VedSettings } from '../../shared/extension-api';
import { useAppearPolicyStore } from './appear-policy';
import { useInvisiblesStore } from './invisibles';
import { type Theme, useThemeStore } from './theme';
import { clampViewConfig, useViewConfigStore, type ViewConfig } from './view-config';
import { useVimStore } from './vim';
import { type SidebarSide, useWorkspaceStore } from './workspace';
import { useWritingModeStore } from './writing-mode';

/** The settings-name → enum mapping (`VedSettings.writingMode`). */
const WRITING_MODES: Readonly<Record<string, WritingMode>> = {
  horizontal: WritingMode.Horizontal,
  vertical: WritingMode.Vertical,
  verticalColumns: WritingMode.VerticalColumns,
  verticalRows: WritingMode.VerticalRows,
  horizontalColumns: WritingMode.HorizontalColumns,
  horizontalRows: WritingMode.HorizontalRows,
};

const APPEAR_POLICIES: readonly string[] = Object.values(AppearPolicy);

/** Every store value `settings.apply` can write — captured once at launch
 *  (after the default-font pick, before the first extension activation) so
 *  re-evaluation resets to what a config-less launch shows, OS theme and
 *  resolved CJK font included. `sidebarOpen` is deliberately ABSENT: after
 *  startup it is session state, so a re-evaluation must leave a runtime
 *  toggle alone (configs apply it under `ctx.activation === 'startup'`). */
export type SettingsBaseline = {
  readonly viewConfig: ViewConfig;
  readonly theme: Theme;
  readonly writingMode: WritingMode;
  readonly appearPolicy: AppearPolicy;
  readonly invisibles: Invisibles;
  readonly vimEnabled: boolean;
  readonly sidebarSide: SidebarSide;
  readonly sidebarWidth: number;
};

export const captureSettingsBaseline = (): SettingsBaseline => ({
  viewConfig: useViewConfigStore.getState().config,
  theme: useThemeStore.getState().theme,
  writingMode: useWritingModeStore.getState().writingMode,
  appearPolicy: useAppearPolicyStore.getState().appearPolicy,
  invisibles: useInvisiblesStore.getState().invisibles,
  vimEnabled: useVimStore.getState().enabled,
  sidebarSide: useWorkspaceStore.getState().sidebarSide,
  sidebarWidth: useWorkspaceStore.getState().sidebarWidth,
});

export const resetSettingsToBaseline = (baseline: SettingsBaseline): void => {
  useViewConfigStore.setState({ config: baseline.viewConfig });
  useThemeStore.getState().set(baseline.theme);
  useWritingModeStore.setState({ writingMode: baseline.writingMode });
  useAppearPolicyStore.setState({ appearPolicy: baseline.appearPolicy });
  useInvisiblesStore.setState({ invisibles: baseline.invisibles });
  useVimStore.setState({ enabled: baseline.vimEnabled });
  useWorkspaceStore.setState({ sidebarSide: baseline.sidebarSide, sidebarWidth: baseline.sidebarWidth });
};

/** The view-config fields of `VedSettings`, all optional numbers but
 *  `fontFamily`. */
const VIEW_CONFIG_KEYS = [
  'fontSize',
  'lineSpaceRatio',
  'pageLineChars',
  'pageLines',
  'pageGapTopCells',
  'pageGapBottomCells',
  'pagesPerRow',
] as const;

/** Reports one invalid field (its name and offending value). */
type ReportBad = (key: string, value: unknown) => void;

const applyViewConfigFields = (settings: VedSettings, bad: ReportBad): void => {
  const patch: Partial<Record<(typeof VIEW_CONFIG_KEYS)[number], number>> = {};
  for (const key of VIEW_CONFIG_KEYS) {
    const value = settings[key];
    if (value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value)) patch[key] = value;
    else bad(key, value);
  }
  let fontFamily: string | null = null;
  if (settings.fontFamily !== undefined) {
    if (typeof settings.fontFamily === 'string') fontFamily = settings.fontFamily;
    else bad('fontFamily', settings.fontFamily);
  }
  if (Object.keys(patch).length === 0 && fontFamily === null) return;
  const current = useViewConfigStore.getState().config;
  useViewConfigStore.setState({
    config: clampViewConfig({ ...current, ...patch, ...(fontFamily === null ? {} : { fontFamily }) }),
  });
};

const applyWritingModeField = (value: VedSettings['writingMode'], bad: ReportBad): void => {
  if (value === undefined) return;
  const mode = typeof value === 'string' ? WRITING_MODES[value] : undefined;
  if (mode !== undefined) useWritingModeStore.setState({ writingMode: mode });
  else bad('writingMode', value);
};

const applyAppearanceFields = (settings: VedSettings, bad: ReportBad): void => {
  if (settings.theme !== undefined) {
    if (settings.theme === 'light' || settings.theme === 'dark') useThemeStore.getState().set(settings.theme);
    else bad('theme', settings.theme);
  }
  applyWritingModeField(settings.writingMode, bad);
  if (settings.appearPolicy !== undefined) {
    if (typeof settings.appearPolicy === 'string' && APPEAR_POLICIES.includes(settings.appearPolicy)) {
      useAppearPolicyStore.setState({ appearPolicy: settings.appearPolicy });
    } else bad('appearPolicy', settings.appearPolicy);
  }
  if (settings.vim !== undefined) {
    if (typeof settings.vim === 'boolean') useVimStore.setState({ enabled: settings.vim });
    else bad('vim', settings.vim);
  }
};

const applyInvisiblesField = (settings: VedSettings, bad: ReportBad): void => {
  if (settings.invisibles === undefined) return;
  if (typeof settings.invisibles !== 'object' || settings.invisibles === null) {
    bad('invisibles', settings.invisibles);
    return;
  }
  const patch: { newline?: boolean; whitespace?: boolean } = {};
  for (const key of ['newline', 'whitespace'] as const) {
    const value = settings.invisibles[key];
    if (value === undefined) continue;
    if (typeof value === 'boolean') patch[key] = value;
    else bad(`invisibles.${key}`, value);
  }
  if (Object.keys(patch).length === 0) return;
  const current = useInvisiblesStore.getState().invisibles;
  useInvisiblesStore.setState({ invisibles: { ...current, ...patch } });
};

const applySidebarFields = (settings: VedSettings, bad: ReportBad): void => {
  if (settings.sidebarOpen !== undefined) {
    if (typeof settings.sidebarOpen === 'boolean') useWorkspaceStore.setState({ sidebarOpen: settings.sidebarOpen });
    else bad('sidebarOpen', settings.sidebarOpen);
  }
  if (settings.sidebarSide !== undefined) {
    if (settings.sidebarSide === 'left' || settings.sidebarSide === 'right') {
      useWorkspaceStore.setState({ sidebarSide: settings.sidebarSide });
    } else bad('sidebarSide', settings.sidebarSide);
  }
  if (settings.sidebarWidth !== undefined) {
    if (typeof settings.sidebarWidth === 'number' && Number.isFinite(settings.sidebarWidth)) {
      useWorkspaceStore.getState().setSidebarWidth(settings.sidebarWidth);
    } else bad('sidebarWidth', settings.sidebarWidth);
  }
};

/**
 * Apply the valid fields of `settings` to the stores; report each invalid
 * one (wrong type / unknown name) and skip it. Numeric view-config fields
 * clamp through `clampViewConfig`; the sidebar width through the workspace
 * store's own clamp.
 */
export const applySettings = (settings: VedSettings, report: (message: string) => void): void => {
  if (typeof settings !== 'object' || settings === null) {
    report('settings.apply: 設定はオブジェクトで指定します');
    return;
  }
  const bad: ReportBad = (key, value) => report(`設定 ${key}: 値が不正です (${JSON.stringify(value)})`);
  applyViewConfigFields(settings, bad);
  applyAppearanceFields(settings, bad);
  applyInvisiblesField(settings, bad);
  applySidebarFields(settings, bad);
};
