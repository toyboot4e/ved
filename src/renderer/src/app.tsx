import { useState } from 'react'
import { AppearPolicy, VedEditor, WritingDirection } from './components/editor'

export const App = (): React.JSX.Element => {
  // const ipcHandle = (): void => window.electron.ipcRenderer.send('ping')
  const [dir, _setDir] = useState(WritingDirection.Vertical)
  const [appearPolicy, setAppearPolicy] = useState(AppearPolicy.Rich)

  return (
    <div className="ved">
      {/* Make space for trafic lights(macOS only) */}
      <div className="ved-header"></div>
      {VedEditor({ dir, appearPolicy, setAppearPolicy })}
      <div className="ved-footer">
        <p id="counter" className="ved-footer-counter"></p>
      </div>
    </div>
  )
}
