import "@testing-library/jest-dom/vitest";

// Radix primitives (Select/Switch) expect a few DOM APIs that jsdom lacks.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {
      // no-op: jsdom does not lay out elements
    }
    unobserve() {
      // no-op
    }
    disconnect() {
      // no-op
    }
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {
    // no-op: jsdom has no scroll container
  };
}

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}

if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {
    // no-op
  };
}
