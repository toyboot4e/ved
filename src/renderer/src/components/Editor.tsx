import { clsx } from 'clsx'

/** Properties of {@link Editor}. */
export type EditorProps = {
  readonly vertical: boolean
}

export const Editor = ({ vertical }: EditorProps): React.JSX.Element => {
  return (
    <div className={clsx('ved-editor', vertical && 'vert-mode', vertical && 'multi-col-mode')}>
      <div
        id="editor-content"
        // className="ved-editor-content vert-mode multi-col-mode"
        className={clsx(
          'ved-editor-content',
          vertical && 'vert-mode',
          vertical && 'multi-col-mode'
        )}
        contentEditable="true"
      ></div>
    </div>
  )
}
