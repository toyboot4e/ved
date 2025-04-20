export const Editor = (): React.JSX.Element => {
  return (
    <div className="ved-editor vert-mode multi-col-mode">
      <div
        id="editor-content"
        className="ved-editor-content vert-mode multi-col-mode"
        contentEditable="true"
      ></div>
    </div>
  )
}

export const App = (): React.JSX.Element => {
  // const ipcHandle = (): void => window.electron.ipcRenderer.send('ping')

  return (
    <div className="ved">
      {/* Make space for trafic lights(macOS only) */}
      <div className="ved-header"></div>
      {Editor()}
      <div className="ved-footer">
        <p id="counter" className="ved-footer-counter"></p>
      </div>
    </div>
  )
}
