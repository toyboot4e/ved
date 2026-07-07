import { editorStyles as styles, WritingMode } from '@ved/editor';
import React from 'react';
import { type JapaneseScanUpdate, scanJapaneseSupport } from '../font-coverage';
import { GENERIC_FONT_FAMILIES, localFontFamilies } from '../local-fonts';
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
  {
    field: 'pageGapTopCells',
    label: 'gap A',
    title:
      'Head margin: space between the page border and the page text, in cells (border→text; below the border in VerticalColumns — including before page 1 — left of it in VerticalRows)',
    step: 0.5,
  },
  {
    field: 'pageGapBottomCells',
    label: 'gap B',
    title:
      'Tail margin: space between the page number and the next border, in cells (folio→border; the VerticalColumns row gap = 1-cell folio strip + A + B, floored at the line-number gutter)',
    step: 0.5,
  },
  { field: 'pagesPerRow', label: '頁/段', title: 'Pages side by side per page row (VerticalColumns only)', step: 1 },
];

const fieldId = (field: string): string => `view-config-${field}`;

/**
 * The font picker's option list: inherit + the CSS generics synchronously
 * (so the control is usable before — or without — enumeration), then the
 * installed families once `queryLocalFonts` resolves.
 */
const useFontFamilies = (): readonly string[] => {
  const [families, setFamilies] = React.useState<readonly string[]>([]);
  React.useEffect(() => {
    let alive = true;
    void localFontFamilies().then((found) => {
      if (alive) setFamilies(found);
    });
    return () => {
      alive = false;
    };
  }, []);
  return families;
};

/**
 * The picker's "JP only" filter: while enabled, probes the families for
 * Japanese coverage (font-coverage.ts) and reports the scan as it fills in.
 * Null while disabled or before the first chunk lands — callers show the
 * unfiltered list then, and whenever the probe reports itself unavailable.
 */
const useJapaneseScan = (enabled: boolean, families: readonly string[]): JapaneseScanUpdate | null => {
  const [scan, setScan] = React.useState<JapaneseScanUpdate | null>(null);
  React.useEffect(() => {
    setScan(null);
    if (!enabled || families.length === 0) return;
    return scanJapaneseSupport(families, setScan);
  }, [enabled, families]);
  return scan;
};

export const ViewConfigControls = ({ writingMode }: { readonly writingMode: WritingMode }): React.JSX.Element => {
  const config = useViewConfigStore((s) => s.config);
  const set = useViewConfigStore((s) => s.set);
  const reset = useViewConfigStore((s) => s.reset);
  const fontFamilies = useFontFamilies();
  const [jpOnly, setJpOnly] = React.useState(false);
  const jpScan = useJapaneseScan(jpOnly, fontFamilies);
  // Unfiltered until the first chunk lands, and always when probing is
  // impossible (jpScan.available false) — never filter on bogus verdicts.
  const shownFamilies = jpOnly && jpScan?.available ? jpScan.jpFamilies : fontFamilies;

  const commitNumber = (field: keyof ViewConfig) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.valueAsNumber;
    if (Number.isFinite(value)) set({ [field]: value });
  };

  return (
    // No preserveFocus here (unlike the button groups): the inputs need the
    // real focus to be typed into.
    <fieldset className={styles.toolbarGroup} aria-label='View config'>
      <span className={styles.toolbarGroupLabel} aria-hidden='true' title='Debug view config (not persisted)'>
        View
      </span>
      {numberFields.map(({ field, label, title, step }) => {
        // 頁/段 only means something under VerticalColumns (app.tsx pins it to 1
        // elsewhere; a VerticalRows page GRID is a Chromium impossibility).
        // Gray it out so it doesn't present as broken.
        const inert = field === 'pagesPerRow' && writingMode !== WritingMode.VerticalColumns;
        return (
          <label key={field} className={styles.toolbarField} title={inert ? `${title} — inert in this mode` : title}>
            {label}
            <input
              id={fieldId(field)}
              className={styles.toolbarNumberInput}
              type='number'
              min={VIEW_CONFIG_BOUNDS[field].min}
              max={VIEW_CONFIG_BOUNDS[field].max}
              step={step}
              value={config[field]}
              disabled={inert}
              onChange={commitNumber(field)}
            />
          </label>
        );
      })}
      <label className={styles.toolbarField} title='Editor font family (inherit = the app font)'>
        font
        <select
          id={fieldId('fontFamily')}
          className={styles.toolbarSelect}
          value={config.fontFamily}
          onChange={(event) => set({ fontFamily: event.target.value })}
        >
          <option value=''>inherit</option>
          {GENERIC_FONT_FAMILIES.map((family) => (
            <option key={family} value={family}>
              {family}
            </option>
          ))}
          {/* A stored value not (yet) in the list — e.g. hydrated config on a
              machine without that font, or one hidden by the JP filter —
              still has to display as itself. */}
          {config.fontFamily !== '' &&
            !shownFamilies.includes(config.fontFamily) &&
            !(GENERIC_FONT_FAMILIES as readonly string[]).includes(config.fontFamily) && (
              <option value={config.fontFamily}>{config.fontFamily}</option>
            )}
          {shownFamilies.map((family) => (
            <option key={family} value={family}>
              {family}
            </option>
          ))}
        </select>
      </label>
      <button
        id={fieldId('font-jp-only')}
        type='button'
        className={styles.toolbarButton}
        aria-pressed={jpOnly}
        title={
          jpOnly && jpScan !== null && !jpScan.available
            ? 'JP-only filter: coverage probing unavailable — showing every font'
            : 'Only list fonts with Japanese glyphs (かな+漢字 probed via canvas)'
        }
        onClick={() => setJpOnly((on) => !on)}
      >
        日本語
      </button>
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
