import { editorStyles as styles } from '@ved/editor';
import type React from 'react';
import { useViewConfigStore, VIEW_CONFIG_BOUNDS, type ViewConfig } from '../view-config';

// Debug view-config controls: an inline toolbar group like the writing-mode
// switcher (editor-ui-plan "Interlude — debug view-config controls"). Writes
// the view-config store; app.tsx turns the store into custom properties on
// the app root. Raw values commit live on every change; clamping happens at
// CSS generation (view-config.ts) so typing through the bounds stays smooth.

type NumberFieldSpec = {
  readonly field: keyof typeof VIEW_CONFIG_BOUNDS;
  readonly label: string;
  readonly title: string;
  readonly step: number;
};

const numberFields: NumberFieldSpec[] = [
  { field: 'fontSize', label: 'px', title: 'Font size in px (the fullwidth cell size)', step: 1 },
  {
    field: 'lineSpaceRatio',
    label: 'lead',
    title: 'Line space as a fraction of the cell (< 0.5 collides ruby)',
    step: 0.05,
  },
  { field: 'pageLineChars', label: '字', title: 'Fullwidth cells per line', step: 1 },
  { field: 'pageLines', label: '行', title: 'Lines per page', step: 1 },
  { field: 'pageGapCells', label: 'gap', title: 'Space between pages (cells)', step: 0.5 },
  { field: 'pagesPerRow', label: '頁/段', title: 'Pages side by side per page row (VerticalColumns only)', step: 1 },
];

const fieldId = (field: string): string => `view-config-${field}`;

export const ViewConfigControls = (): React.JSX.Element => {
  const config = useViewConfigStore((s) => s.config);
  const set = useViewConfigStore((s) => s.set);
  const reset = useViewConfigStore((s) => s.reset);

  const commitNumber = (field: keyof ViewConfig) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.valueAsNumber;
    if (Number.isFinite(value)) set({ [field]: value });
  };

  return (
    // No keepEditorFocus here (unlike the button groups): the inputs need the
    // real focus to be typed into.
    <fieldset className={styles.toolbarGroup} aria-label='View config'>
      <span className={styles.toolbarGroupLabel} aria-hidden='true' title='Debug view config (not persisted)'>
        View
      </span>
      {numberFields.map(({ field, label, title, step }) => (
        <label key={field} className={styles.toolbarField} title={title}>
          {label}
          <input
            id={fieldId(field)}
            className={styles.toolbarNumberInput}
            type='number'
            min={VIEW_CONFIG_BOUNDS[field].min}
            max={VIEW_CONFIG_BOUNDS[field].max}
            step={step}
            value={config[field]}
            onChange={commitNumber(field)}
          />
        </label>
      ))}
      <label className={styles.toolbarField} title='Editor font family (empty = inherit the app font)'>
        font
        <input
          id={fieldId('fontFamily')}
          className={styles.toolbarTextInput}
          type='text'
          placeholder='inherit'
          value={config.fontFamily}
          onChange={(event) => set({ fontFamily: event.target.value })}
        />
      </label>
      <button
        id={fieldId('reset')}
        type='button'
        className={styles.toolbarButton}
        title='Reset the view config to defaults'
        onClick={reset}
      >
        ↺
      </button>
    </fieldset>
  );
};
