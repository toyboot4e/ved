import { AppearPolicy, PlainTextHistory, editorStyles as styles, VedEditor, WritingMode } from '@ved/editor';
import { clsx } from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { type ViewConfig, viewConfigFromPersisted, viewConfigToCss } from './view-config';
import { ViewConfigControls } from './view-config-controls';

// A throwaway preview: one in-memory buffer plus controls for both axes
// (writing mode + appear policy) and the debug view config (font size, 字/行,
// gaps, 頁/段, font). Not for real use — no files, no tabs, no IPC.
// State survives a reload via localStorage so a mis-reload doesn't lose text.

const STORAGE_KEY = 'ved.web.preview';

const SEED_TEXT = `|吾輩(わがはい)は猫である。
名前はまだ|無(な)い。
どこで|生(う)まれたか|頓(とん)と|見当(けんとう)がつかぬ。
何でも|薄暗(うすぐら)いじめじめした|所(ところ)でニャーニャー|泣(な)いていた事だけは|記憶(きおく)している。`;

type Persisted = {
  text: string;
  writingMode: WritingMode;
  appearPolicy: AppearPolicy;
  viewConfig: ViewConfig;
};

const WRITING_MODES: ReadonlyArray<readonly [WritingMode, string]> = [
  [WritingMode.Horizontal, 'Horizontal'],
  [WritingMode.Vertical, 'Vertical'],
  [WritingMode.VerticalColumns, 'VerticalColumns'],
  [WritingMode.VerticalRows, 'VerticalRows'],
];

const APPEAR_POLICIES: ReadonlyArray<readonly [AppearPolicy, string]> = [
  [AppearPolicy.Plain, 'Plain'],
  [AppearPolicy.ByParagraph, 'ByParagraph'],
  [AppearPolicy.ByCharacter, 'ByCharacter'],
  [AppearPolicy.Rich, 'Rich'],
];

const loadPersisted = (): Persisted => {
  const fallback: Persisted = {
    text: SEED_TEXT,
    writingMode: WritingMode.Vertical,
    appearPolicy: AppearPolicy.Rich,
    viewConfig: viewConfigFromPersisted(undefined),
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : fallback.text,
      writingMode: parsed.writingMode ?? fallback.writingMode,
      // Validated: AppearPolicy became string-valued; a stale numeric from an
      // older localStorage entry falls back (a one-time reset of a debug knob).
      appearPolicy: (Object.values(AppearPolicy) as unknown[]).includes(parsed.appearPolicy)
        ? (parsed.appearPolicy as AppearPolicy)
        : fallback.appearPolicy,
      viewConfig: viewConfigFromPersisted(parsed.viewConfig),
    };
  } catch {
    return fallback;
  }
};

export const App = (): React.JSX.Element => {
  const initial = useMemo(loadPersisted, []);
  const [text, setText] = useState(initial.text);
  const [writingMode, setWritingMode] = useState(initial.writingMode);
  const [appearPolicy, setAppearPolicy] = useState(initial.appearPolicy);
  const [viewConfig, setViewConfig] = useState(initial.viewConfig);
  // One history instance for the buffer's lifetime, seeded from the loaded text.
  const history = useMemo(() => new PlainTextHistory(initial.text), [initial.text]);

  // Persist text + the control axes on every change (text restored on a mis-reload).
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ text, writingMode, appearPolicy, viewConfig }));
    } catch {
      // Storage unavailable (private mode / quota) — the preview still works.
    }
  }, [text, writingMode, appearPolicy, viewConfig]);

  return (
    <>
      <div className='controls'>
        <label>
          Writing mode
          <select value={writingMode} onChange={(e) => setWritingMode(Number(e.target.value) as WritingMode)}>
            {WRITING_MODES.map(([mode, label]) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Appear policy
          <select value={appearPolicy} onChange={(e) => setAppearPolicy(e.target.value as AppearPolicy)}>
            {APPEAR_POLICIES.map(([policy, label]) => (
              <option key={policy} value={policy}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <ViewConfigControls writingMode={writingMode} config={viewConfig} setConfig={setViewConfig} />
      </div>
      <div className='stage'>
        {/* vertMode on the root transposes the page geometry (CSS custom props);
            the view config overrides the geometry custom props inline.
            pagesPerRow only means something in VerticalColumns —
            pin it to 1 elsewhere so the root/page widths stay one page.
            rowsMode widens the root to the window: VerticalRows scrolls along
            the horizontal axis, so a wide window shows more lines. */}
        <div
          className={clsx(
            styles.root,
            writingMode !== WritingMode.Horizontal && styles.vertMode,
            writingMode === WritingMode.VerticalRows && styles.rowsMode,
          )}
          style={viewConfigToCss(
            writingMode === WritingMode.VerticalColumns ? viewConfig : { ...viewConfig, pagesPerRow: 1 },
          )}
        >
          <VedEditor
            initialText={text}
            history={history}
            writingMode={writingMode}
            appearPolicy={appearPolicy}
            setAppearPolicy={setAppearPolicy}
            onTextChange={setText}
            viewConfigEpoch={viewConfig}
          />
        </div>
      </div>
    </>
  );
};
