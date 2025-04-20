import { Editor } from './components/Editor'

export const App = (): React.JSX.Element => {
  // const ipcHandle = (): void => window.electron.ipcRenderer.send('ping')

  return (
    <div className="ved">
      {/* Make space for trafic lights(macOS only) */}
      <div className="ved-header"></div>
      {Editor({ vertical: true })}
      <div className="ved-footer">
        <p id="counter" className="ved-footer-counter"></p>
      </div>
    </div>
  )
}
