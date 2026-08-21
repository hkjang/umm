import '@testing-library/jest-dom/vitest';

// jsdom has no layout engine, so components that measure or observe elements
// need these stubs to render at all.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= ResizeObserverStub as unknown as typeof IntersectionObserver;

globalThis.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof globalThis.matchMedia;

globalThis.scrollTo ??= (() => {}) as unknown as typeof globalThis.scrollTo;
