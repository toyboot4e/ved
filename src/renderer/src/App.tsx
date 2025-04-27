import { VedEditor, WritingDirection } from './components/Editor'
import { useState } from 'react'

export const App = (): React.JSX.Element => {
  // const ipcHandle = (): void => window.electron.ipcRenderer.send('ping')
  const [dir, _setDir] = useState(WritingDirection.Vertical)

  return (
    <div className="ved">
      {/* Make space for trafic lights(macOS only) */}
      <div className="ved-header"></div>
      {VedEditor({ dir })}
      <div className="ved-footer">
        <p id="counter" className="ved-footer-counter"></p>
      </div>
    </div>
  )
}
