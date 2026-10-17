// TabularForm heuristic: flat primitive fields -> tabular cells; nested objects
// and arrays -> collapsible cards (never a cell); cards collapse/expand.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TabularForm, getAtPointer } from '../tabular-form'

const value = {
  name: 'termsheet1',
  strike: 0.78,
  memory: true,
  nested: { child: 1, grand: { deep: 2 } },
  tags: ['a', 'b'],
  legs: [{ put: { barrier: 0.7 } }],
}

describe('getAtPointer', () => {
  it('resolves nested object and array pointers', () => {
    expect(getAtPointer(value, '/nested/grand/deep')).toBe(2)
    expect(getAtPointer(value, '/tags/1')).toBe('b')
  })
})

describe('TabularForm heuristic', () => {
  it('renders flat primitive fields as tabular cells', () => {
    const { container } = render(<TabularForm value={value} onChange={() => {}} />)
    expect(container.querySelector('.fina-form-grid')).toBeTruthy()
    expect(container.querySelector('[data-tabular-path="/name"]')).toBeTruthy()
    expect(container.querySelector('[data-tabular-path="/strike"]')).toBeTruthy()
    expect(container.querySelector('[data-tabular-path="/memory"]')).toBeTruthy()
  })

  it('never renders a nested object or array in a cell', () => {
    const { container } = render(<TabularForm value={value} onChange={() => {}} />)
    for (const pointer of ['/nested', '/tags', '/legs']) {
      expect(container.querySelector(`[data-tabular-path="${pointer}"]`)).toBeNull()
    }
  })

  it('renders nested objects and arrays as collapsible cards', () => {
    render(<TabularForm value={value} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: /Nested/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Tags/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Legs/ })).toBeTruthy()
  })

  it('collapses and expands a nested card from its header', () => {
    const { container } = render(<TabularForm value={value} onChange={() => {}} />)
    // `nested` (depth 1) is open by default, so its child cell is present.
    expect(container.querySelector('[data-tabular-path="/nested/child"]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Nested/ }))
    expect(container.querySelector('[data-tabular-path="/nested/child"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Nested/ }))
    expect(container.querySelector('[data-tabular-path="/nested/child"]')).toBeTruthy()
  })

  it('reports edits as (pointer, value)', () => {
    const onChange = vi.fn()
    const { container } = render(<TabularForm value={value} onChange={onChange} />)
    const input = container.querySelector('[data-tabular-path="/strike"] input')!
    fireEvent.change(input, { target: { value: '0.5' } })
    expect(onChange).toHaveBeenCalledWith('/strike', 0.5)
  })

  it('prefixes emitted pointers when editing a sub-object', () => {
    const onChange = vi.fn()
    const { container } = render(
      <TabularForm value={value.nested} pathPrefix="/nested" onChange={onChange} />,
    )
    const input = container.querySelector('[data-tabular-path="/nested/child"] input')!
    fireEvent.change(input, { target: { value: '9' } })
    expect(onChange).toHaveBeenCalledWith('/nested/child', 9)
  })
})
