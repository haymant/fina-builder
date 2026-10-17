// TabularForm heuristic: flat primitive fields -> tabular cells; nested objects
// and arrays -> collapsible cards (never a cell); cards collapse/expand.

import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
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

  it('keeps primitives of a mixed array as cells and containers as cards', () => {
    const { container } = render(
      <TabularForm value={{ mixed: [1, { obj: 2 }, 'three'] }} onChange={() => {}} />,
    )
    // primitives keep their index cells
    expect(container.querySelector('[data-tabular-path="/mixed/0"]')).toBeTruthy()
    expect(container.querySelector('[data-tabular-path="/mixed/2"]')).toBeTruthy()
    // the object entry is a card, not a cell
    expect(container.querySelector('[data-tabular-path="/mixed/1"]')).toBeNull()
  })

  it('renders raw (verbatim source) fields read-only', () => {
    const onChange = vi.fn()
    const { container } = render(
      <TabularForm value={{ rails: { raw: { PRKI2: -1, KIBarrier: 0.7 } } }} onChange={onChange} />,
    )
    // `raw` is collapsed by default; expand it to inspect.
    fireEvent.click(screen.getByRole('button', { name: /Raw/ }))
    const cell = container.querySelector('[data-tabular-path="/rails/raw/PRKI2"]')
    expect(cell).toBeTruthy()
    // read-only: rendered as text, not an editable input
    expect(cell?.querySelector('input')).toBeNull()
  })

  it('keeps the numeric editor when a numeric value is cleared', () => {
    function Harness() {
      const [value, setValue] = useState<Record<string, unknown>>({ strike: 0.78 })
      return (
        <TabularForm
          value={value}
          onChange={(pointer, next) => setValue((prev) => ({ ...prev, [pointer.slice(1)]: next }))}
        />
      )
    }
    const { container } = render(<Harness />)
    const before = container.querySelector('[data-tabular-path="/strike"] input') as HTMLInputElement
    expect(before.type).toBe('number')

    fireEvent.change(before, { target: { value: '' } })
    // cleared -> null, and the input is STILL numeric (arrows/steppers remain)
    const after = container.querySelector('[data-tabular-path="/strike"] input') as HTMLInputElement
    expect(after.type).toBe('number')
  })

  it('promotes numeric-looking input to a number, never a string', () => {
    const onChange = vi.fn()
    const { container } = render(<TabularForm value={{ couponBarrier: null }} onChange={onChange} />)
    fireEvent.change(container.querySelector('[data-tabular-path="/couponBarrier"] input')!, {
      target: { value: '0.6' },
    })
    expect(onChange).toHaveBeenCalledWith('/couponBarrier', 0.6)
  })

  it('leaves a genuine string alone', () => {
    const onChange = vi.fn()
    const { container } = render(<TabularForm value={{ symbol: 'ADBE' }} onChange={onChange} />)
    fireEvent.change(container.querySelector('[data-tabular-path="/symbol"] input')!, {
      target: { value: 'MSFT' },
    })
    expect(onChange).toHaveBeenCalledWith('/symbol', 'MSFT')
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
