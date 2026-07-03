import { WritingMode } from '@ved/editor';
import React from 'react';
import { VIEW_CONFIG_BOUNDS, VIEW_CONFIG_DEFAULTS, type ViewConfig } from './view-config';

// Debug view-config controls, mirroring the desktop toolbar's field set
// (desktop/src/renderer/src/components/view-config-controls.tsx). Raw values
// commit live on every change; clamping happens at CSS generation
// (view-config.ts) so typing through the bounds stays smooth.

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
    title: 'Head margin: space between the page border and the page text, in cells',
    step: 0.5,
  },
  {
    field: 'pageGapBottomCells',
    label: 'gap B',
    title: 'Tail margin: space between the page number and the next border, in cells',
    step: 0.5,
  },
  { field: 'pagesPerRow', label: '頁/段', title: 'Pages side by side per page row (VerticalColumns only)', step: 1 },
];

/** The CSS generic families the picker always offers, even when enumeration fails. */
const GENERIC_FONT_FAMILIES = ['serif', 'sans-serif', 'monospace'] as const;

type LocalFontData = { readonly family: string };
type QueryLocalFonts = () => Promise<readonly LocalFontData[]>;

/**
 * The installed font families via `queryLocalFonts`, deduplicated and
 * locale-sorted. Unlike Electron, a plain browser gates the API behind a user
 * gesture + permission prompt, so this runs from the picker's pointerdown, not
 * on mount. Empty when the API is missing or denied — the picker then degrades
 * to {@link GENERIC_FONT_FAMILIES} only.
 */
const localFontFamilies = async (): Promise<readonly string[]> => {
  const query = (window as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (query === undefined) return [];
  try {
    const fonts = await query.call(window);
    return [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
};

export type ViewConfigControlsProps = {
  readonly writingMode: WritingMode;
  readonly config: ViewConfig;
  readonly setConfig: React.Dispatch<React.SetStateAction<ViewConfig>>;
};

export const ViewConfigControls = ({ writingMode, config, setConfig }: ViewConfigControlsProps): React.JSX.Element => {
  const [fontFamilies, setFontFamilies] = React.useState<readonly string[]>([]);
  const enumeratedRef = React.useRef(false);
  const enumerateFonts = (): void => {
    if (enumeratedRef.current) return;
    enumeratedRef.current = true;
    void localFontFamilies().then(setFontFamilies);
  };

  const commitNumber = (field: keyof ViewConfig) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.valueAsNumber;
    if (Number.isFinite(value)) setConfig((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <>
      {numberFields.map(({ field, label, title, step }) => {
        // 頁/段 only means something under VerticalColumns (app.tsx pins it to 1
        // elsewhere; a VerticalRows page GRID is a Chromium impossibility —
        // ADR-0011). Gray it out so it doesn't present as broken.
        const inert = field === 'pagesPerRow' && writingMode !== WritingMode.VerticalColumns;
        return (
          <label key={field} title={inert ? `${title} — inert in this mode` : title}>
            {label}
            <input
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
      <label title='Editor font family (inherit = the app font)'>
        font
        <select
          value={config.fontFamily}
          onPointerDown={enumerateFonts}
          onChange={(event) => setConfig((prev) => ({ ...prev, fontFamily: event.target.value }))}
        >
          <option value=''>inherit</option>
          {GENERIC_FONT_FAMILIES.map((family) => (
            <option key={family} value={family}>
              {family}
            </option>
          ))}
          {/* A persisted value not (yet) in the list — e.g. restored on a
              machine without that font — still has to display as itself. */}
          {config.fontFamily !== '' &&
            !fontFamilies.includes(config.fontFamily) &&
            !(GENERIC_FONT_FAMILIES as readonly string[]).includes(config.fontFamily) && (
              <option value={config.fontFamily}>{config.fontFamily}</option>
            )}
          {fontFamilies.map((family) => (
            <option key={family} value={family}>
              {family}
            </option>
          ))}
        </select>
      </label>
      <button type='button' title='Reset the view config to defaults' onClick={() => setConfig(VIEW_CONFIG_DEFAULTS)}>
        ↺
      </button>
    </>
  );
};
