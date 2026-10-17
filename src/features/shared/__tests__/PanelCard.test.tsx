// PanelCard: collapsible header + vertical auto-scroll body.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PanelCard } from '../components/PanelCard'

describe('PanelCard', () => {
  it('collapses and expands the body from the header', () => {
    render(
      <PanelCard title="Trade">
        <div>body-content</div>
      </PanelCard>,
    )
    expect(screen.getByText('body-content')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Trade/ }))
    expect(screen.queryByText('body-content')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Trade/ }))
    expect(screen.getByText('body-content')).toBeTruthy()
  })

  it('scrolls the body vertically by default', () => {
    const { container } = render(
      <PanelCard title="Trade">
        <div>body</div>
      </PanelCard>,
    )
    expect(container.querySelector('.overflow-y-auto')).toBeTruthy()
  })

  it('lets a caller override the body overflow', () => {
    const { container } = render(
      <PanelCard title="Trade" bodyClassName="overflow-hidden">
        <div>body</div>
      </PanelCard>,
    )
    expect(container.querySelector('.overflow-y-auto')).toBeNull()
    expect(container.querySelector('.overflow-hidden')).toBeTruthy()
  })

  it('can render without the collapse control', () => {
    render(
      <PanelCard title="Trade" collapsible={false}>
        <div>body-content</div>
      </PanelCard>,
    )
    expect(screen.queryByRole('button', { name: /Trade/ })).toBeNull()
    expect(screen.getByText('body-content')).toBeTruthy()
  })
})
