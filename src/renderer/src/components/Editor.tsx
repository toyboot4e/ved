import { clsx } from 'clsx'
import { createEditor } from 'slate'
import { Slate, withReact, Editable } from 'slate-react'
import { useState } from 'react'

/** Properties of {@link Editor}. */
export type EditorProps = {
  readonly vertical: boolean
}

export const Editor = ({ vertical }: EditorProps): React.JSX.Element => {
  const [editor] = useState(() => withReact(createEditor()))
  const initialValue = [{ type: 'paragraph', children: [{ text: '' }] }]

  return (
    <div className={clsx('ved-editor', vertical && 'vert-mode', vertical && 'multi-col-mode')}>
      <Slate editor={editor} initialValue={initialValue}>
        <Editable
          id="editor-content"
          placeholder="本文"
          className={clsx(
            'ved-editor-content',
            vertical && 'vert-mode',
            vertical && 'multi-col-mode'
          )}
        />
      </Slate>
    </div>
  )
}
