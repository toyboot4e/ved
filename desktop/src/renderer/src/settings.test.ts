import { AppearPolicy, WritingMode } from '@ved/editor';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppearPolicyStore } from './appear-policy';
import { useInvisiblesStore } from './invisibles';
import { applySettings, captureSettingsBaseline, resetSettingsToBaseline } from './settings';
import { useThemeStore } from './theme';
import { useViewConfigStore, VIEW_CONFIG_BOUNDS } from './view-config';
import { useVimStore } from './vim';
import { SIDEBAR_MAX_WIDTH, useWorkspaceStore } from './workspace';
import { useWritingModeStore } from './writing-mode';

// The pristine store values (node env: OS theme resolves to 'light').
const pristine = captureSettingsBaseline();

const reports: string[] = [];
const report = (message: string): void => {
  reports.push(message);
};

beforeEach(() => {
  resetSettingsToBaseline(pristine);
  reports.length = 0;
});

describe('applySettings', () => {
  it('applies view-config fields, clamped to their bounds', () => {
    applySettings({ fontSize: 23, pageLines: 9999, fontFamily: 'Noto Serif CJK JP' }, report);
    const config = useViewConfigStore.getState().config;
    expect(config.fontSize).toBe(23);
    expect(config.pageLines).toBe(VIEW_CONFIG_BOUNDS.pageLines.max);
    expect(config.fontFamily).toBe('Noto Serif CJK JP');
    expect(reports).toEqual([]);
  });

  it('maps writing-mode names onto the enum', () => {
    applySettings({ writingMode: 'horizontalRows' }, report);
    expect(useWritingModeStore.getState().writingMode).toBe(WritingMode.HorizontalRows);
    expect(reports).toEqual([]);
  });

  it('applies theme, appear policy, invisibles (partial), vim, and sidebar', () => {
    applySettings(
      {
        theme: 'dark',
        appearPolicy: 'plain',
        invisibles: { whitespace: true },
        vim: true,
        sidebarSide: 'right',
        sidebarWidth: 300,
      },
      report,
    );
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(useAppearPolicyStore.getState().appearPolicy).toBe(AppearPolicy.Plain);
    // Partial: the omitted key keeps its current value.
    expect(useInvisiblesStore.getState().invisibles).toEqual({ ...pristine.invisibles, whitespace: true });
    expect(useVimStore.getState().enabled).toBe(true);
    expect(useWorkspaceStore.getState().sidebarSide).toBe('right');
    expect(useWorkspaceStore.getState().sidebarWidth).toBe(300);
    expect(reports).toEqual([]);
  });

  it('clamps the sidebar width through the store bounds', () => {
    applySettings({ sidebarWidth: 99999 }, report);
    expect(useWorkspaceStore.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('reports and skips each invalid field, still applying the valid ones', () => {
    applySettings(
      // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard against untyped user code
      { fontSize: 'huge', theme: 'sepia', writingMode: 'diagonal', appearPolicy: 7, vim: 1, fontFamily: 20 } as any,
      report,
    );
    expect(reports).toHaveLength(6);
    expect(useViewConfigStore.getState().config).toEqual(pristine.viewConfig);
    expect(useThemeStore.getState().theme).toBe(pristine.theme);
    applySettings({ fontSize: 'huge', pageLines: 30 } as never, report);
    expect(useViewConfigStore.getState().config.pageLines).toBe(30);
  });

  it('reports a non-object invisibles value', () => {
    applySettings({ invisibles: 'all' } as never, report);
    expect(reports).toHaveLength(1);
    expect(useInvisiblesStore.getState().invisibles).toEqual(pristine.invisibles);
  });

  it('refuses a non-object settings value outright', () => {
    applySettings('dark' as never, report);
    expect(reports).toHaveLength(1);
  });
});

describe('the launch baseline', () => {
  it('reset restores every store applySettings can write', () => {
    applySettings(
      {
        fontSize: 30,
        theme: 'dark',
        writingMode: 'vertical',
        appearPolicy: 'char',
        invisibles: { newline: false, whitespace: true },
        vim: true,
        sidebarSide: 'right',
        sidebarWidth: 320,
      },
      report,
    );
    resetSettingsToBaseline(pristine);
    expect(captureSettingsBaseline()).toEqual(pristine);
  });

  it('captures the CURRENT values — a font picked before capture survives resets', () => {
    useViewConfigStore.getState().set({ fontFamily: 'Picked CJK' });
    const baseline = captureSettingsBaseline();
    applySettings({ fontFamily: 'User Font', fontSize: 25 }, report);
    resetSettingsToBaseline(baseline);
    expect(useViewConfigStore.getState().config.fontFamily).toBe('Picked CJK');
    expect(useViewConfigStore.getState().config.fontSize).toBe(pristine.viewConfig.fontSize);
  });
});
