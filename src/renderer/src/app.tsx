import { useState } from 'react';
import { AppearPolicy, VedEditor, WritingMode } from './components/editor';
import styles from './components/editor.module.scss';
import { Toolbar } from './components/toolbar';

export const App = (): React.JSX.Element => {
  const [writingMode, setWritingMode] = useState(WritingMode.VerticalColumns);
  const [appearPolicy, setAppearPolicy] = useState(AppearPolicy.Rich);

  return (
    <div className={styles.root}>
      {/* Also makes space for traffic lights (macOS only) */}
      <div className={styles.header}>
        <Toolbar
          writingMode={writingMode}
          setWritingMode={setWritingMode}
          appearPolicy={appearPolicy}
          setAppearPolicy={setAppearPolicy}
        />
      </div>
      <VedEditor
        initialText='|ルビ(ruby)'
        writingMode={writingMode}
        appearPolicy={appearPolicy}
        setAppearPolicy={setAppearPolicy}
      />
      <div className={styles.footer}>
        <p id='counter' className={styles.footerCounter}></p>
      </div>
    </div>
  );
};
