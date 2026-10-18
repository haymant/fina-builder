// Vitest setup (FEATURES.md §6.2): jsdom stubs for the APIs the
// tiles touch, per-test localStorage isolation, and RTL cleanup.

import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

afterEach(() => cleanup())

beforeEach(() => {
  localStorage.clear()
})

// jsdom does not implement these; the dashboard/graph code touches them.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
Object.defineProperty(window, 'ResizeObserver', { writable: true, value: ResizeObserverStub })

class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return []
  }
  root = null
  rootMargin = ''
  thresholds = []
}
Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  value: IntersectionObserverStub,
})

Object.defineProperty(globalThis, 'crypto', {
  value: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
})
// ECharts (canvas renderer) calls 2D-context methods — including on dispose.
// jsdom returns null from `getContext` without the native `canvas` package, so a
// chart tile can throw `clearRect on null` during unmount. A no-op stub keeps
// every chart tile renderable (and disposable) under jsdom.
const ctx2dStub = {
  canvas: null as unknown,
  clearRect: () => {},
  fillRect: () => {},
  strokeRect: () => {},
  beginPath: () => {},
  closePath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  arc: () => {},
  arcTo: () => {},
  rect: () => {},
  quadraticCurveTo: () => {},
  bezierCurveTo: () => {},
  fill: () => {},
  stroke: () => {},
  clip: () => {},
  drawImage: () => {},
  save: () => {},
  restore: () => {},
  translate: () => {},
  scale: () => {},
  rotate: () => {},
  setTransform: () => {},
  transform: () => {},
  resetTransform: () => {},
  setLineDash: () => {},
  getLineDash: () => [],
  measureText: () => ({ width: 0 }),
  fillText: () => {},
  strokeText: () => {},
  createLinearGradient: () => ({ addColorStop: () => {} }),
  createRadialGradient: () => ({ addColorStop: () => {} }),
  createPattern: () => null,
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  putImageData: () => {},
}
Object.defineProperty(globalThis.HTMLCanvasElement.prototype, 'getContext', {
  writable: true,
  value: () => ctx2dStub,
})
