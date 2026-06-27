import { AppearPolicy, PlainTextHistory, editorStyles as styles, VedEditor, WritingMode } from '@ved/editor';
import { clsx } from 'clsx';
import { useEffect, useMemo, useState } from 'react';

// A throwaway preview: one in-memory buffer plus controls for both axes
// (writing mode + appear policy). Not for real use — no files, no tabs, no IPC.
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
};

const WRITING_MODES: ReadonlyArray<readonly [WritingMode, string]> = [
  [WritingMode.Horizontal, 'Horizontal'],
  [WritingMode.Vertical, 'Vertical'],
  [WritingMode.VerticalColumns, 'VerticalColumns'],
  [WritingMode.VerticalRows, 'VerticalRows'],
];

const APPEAR_POLICIES: ReadonlyArray<readonly [AppearPolicy, string]> = [
  [AppearPolicy.ShowAll, 'ShowAll'],
  [AppearPolicy.ByParagraph, 'ByParagraph'],
  [AppearPolicy.ByCharacter, 'ByCharacter'],
  [AppearPolicy.Rich, 'Rich'],
];

const loadPersisted = (): Persisted => {
  const fallback: Persisted = {
    text: SEED_TEXT,
    writingMode: WritingMode.Vertical,
    appearPolicy: AppearPolicy.Rich,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : fallback.text,
      writingMode: parsed.writingMode ?? fallback.writingMode,
      appearPolicy: parsed.appearPolicy ?? fallback.appearPolicy,
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
  // One history instance for the buffer's lifetime, seeded from the loaded text.
  const history = useMemo(() => new PlainTextHistory(initial.text), [initial.text]);

  // Persist text + both axes on every change (text restored on a mis-reload).
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ text, writingMode, appearPolicy }));
    } catch {
      // Storage unavailable (private mode / quota) — the preview still works.
    }
  }, [text, writingMode, appearPolicy]);

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
          <select value={appearPolicy} onChange={(e) => setAppearPolicy(Number(e.target.value) as AppearPolicy)}>
            {APPEAR_POLICIES.map(([policy, label]) => (
              <option key={policy} value={policy}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className='stage'>
        {/* vertMode on the root transposes the page geometry (CSS custom props). */}
        <div className={clsx(styles.root, writingMode !== WritingMode.Horizontal && styles.vertMode)}>
          <VedEditor
            initialText={text}
            history={history}
            writingMode={writingMode}
            appearPolicy={appearPolicy}
            setAppearPolicy={setAppearPolicy}
            onTextChange={setText}
          />
        </div>
      </div>
    </>
  );
};
