// TabularForm: finap-style `.fina-form-grid` of bordered Field | Value cells.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TabularForm, getAtPointer } from '../tabular-form'

const value = {
  meta: { name: 'termsheet1' },
  legs: [{ put: { strike: 0.78, memoryCoupon: true } }],
  spots: [239.97, 260],
}

const sections = [
  {
    title: 'Identity',
    fields: [
      { path: '/meta/name', label: 'Trade name' },
      { path: '/legs/0/put/strike', label: 'Strike' },
      { path: '/legs/0/put/memoryCoupon', label: 'Memory coupon', renderer: 'switch' as const },
      { path: '/spots/0', label: 'Spot 1' },
    ],
  },
]

describe('getAtPointer', () => {
  it('resolves nested object and array pointers', () => {
    expect(getAtPointer(value, '/legs/0/put/strike')).toBe(0.78)
    expect(getAtPointer(value, '/spots/1')).toBe(260)
    expect(getAtPointer(value, '/meta')).toEqual({ name: 'termsheet1' })
  })
})

describe('TabularForm', () => {
  it('renders a finap-style grid with one cell per field', () => {
    const { container } = render(<TabularForm value={value} sections={sections} onChange={() => {}} />)
    expect(container.querySelector('.fina-form-grid')).toBeTruthy()
    expect(container.querySelector('.fina-form-container')).toBeTruthy()
    expect(container.querySelectorAll('[data-tabular-path]')).toHaveLength(4)
    expect(screen.getByText('Identity')).toBeTruthy()
    expect(screen.getByText('Strike')).toBeTruthy()
  })

  it('reports edits as (pointer, value)', () => {
    const onChange = vi.fn()
    render(<TabularForm value={value} sections={sections} onChange={onChange} />)
    const strike = document.querySelector('[data-tabular-path="/legs/0/put/strike"] input')!
    fireEvent.change(strike, { target: { value: '0.5' } })
    expect(onChange).toHaveBeenCalledWith('/legs/0/put/strike', 0.5)
  })

  it('marks the last cell to fill the row', () => {
    const { container } = render(<TabularForm value={value} sections={sections} onChange={() => {}} />)
    expect(container.querySelector('.fina-form-fill-right')).toBeTruthy()
  })
})
