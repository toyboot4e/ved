import type { Meta, StoryObj } from '@storybook/react'

import { VedEditor } from './Editor'

// TODO: Is it good idea to import here?
import '../assets/main.css'
import '../assets/editor.css'

const meta = {
  component: VedEditor,
  title: 'Editor',
  tags: ['autodocs']
} satisfies Meta<typeof VedEditor>

export default meta
type Story = StoryObj<typeof meta>

export const Vertical: Story = {
  args: {
    vertical: true
  }
}

export const Horizontal: Story = {
  args: {
    vertical: false
  }
}
