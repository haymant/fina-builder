// The template gallery offers a blank (no-tile) dashboard as well as templates.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TemplateGallery } from '../components/TemplateGallery'

describe('TemplateGallery', () => {
  it('creates an empty dashboard with no tiles', () => {
    const onCreate = vi.fn()
    render(<TemplateGallery open onClose={() => {}} onCreate={onCreate} />)
    fireEvent.click(screen.getByText('Create empty dashboard'))
    expect(onCreate).toHaveBeenCalledTimes(1)
    const [, layout] = onCreate.mock.calls[0]
    expect(layout).toEqual([])
  })

  it('still offers template dashboards with tiles', () => {
    const onCreate = vi.fn()
    render(<TemplateGallery open onClose={() => {}} onCreate={onCreate} />)
    const buttons = screen.getAllByText('Create dashboard')
    expect(buttons.length).toBeGreaterThan(0)
    fireEvent.click(buttons[0]!)
    const [, layout] = onCreate.mock.calls[0]
    expect(Array.isArray(layout)).toBe(true)
    expect(layout.length).toBeGreaterThan(0)
  })

  it('renders nothing when closed', () => {
    const { container } = render(<TemplateGallery open={false} onClose={() => {}} onCreate={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})
