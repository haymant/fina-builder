// Native `window.confirm` is unreliable in Tauri webviews; destructive actions
// use this in-app dialog instead.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '../components/ConfirmDialog'

describe('ConfirmDialog', () => {
  it('renders nothing while closed', () => {
    render(<ConfirmDialog open={false} title="Delete?" message="gone" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('invokes confirm and cancel from the buttons', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ConfirmDialog open title="Delete dashboard?" message="This removes the layout." confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Delete dashboard?')).toBeTruthy()
    fireEvent.click(screen.getByTestId('confirm-accept'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('confirm-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('cancels on Escape and on a backdrop click, but not on an inside click', () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog open title="Delete?" message="gone" onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('confirm-dialog'))
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(screen.getByTestId('confirm-dialog-backdrop'))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
