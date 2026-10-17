import { describe, expect, it } from 'vitest'
import { cn } from '../utils'

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('drops falsy values', () => {
    expect(cn('a', false, undefined, null, '', 'b')).toBe('a b')
  })

  it('supports conditional object syntax', () => {
    expect(cn('base', { on: true, off: false })).toBe('base on')
  })

  it('merges conflicting Tailwind utilities (last wins)', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4')
    expect(cn('text-muted-foreground', 'text-foreground')).toBe('text-foreground')
  })
})
