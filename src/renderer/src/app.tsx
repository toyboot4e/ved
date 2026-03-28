import { useState } from 'react';
import { AppearPolicy, VedEditor, WritingDirection } from './components/editor';
import styles from './components/editor.module.scss';

export const App = (): React.JSX.Element => {
  // const ipcHandle = (): void => window.electron.ipcRenderer.send('ping')
  const [dir, _setDir] = useState(WritingDirection.Vertical);
  const [appearPolicy, setAppearPolicy] = useState(AppearPolicy.Rich);

  return (
    <div className={styles.root}>
      {/* Make space for trafic lights(macOS only) */}
      <div className={styles.header}></div>
      {VedEditor({ dir, appearPolicy, setAppearPolicy })}
      <div className={styles.footer}>
        <p id='counter' className={styles.footerCounter}></p>
      </div>
    </div>
  );
};
