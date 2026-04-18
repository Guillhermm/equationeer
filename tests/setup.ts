import "@testing-library/jest-dom";
import "fake-indexeddb/auto";
import { vi } from "vitest";

// Minimal Chrome API mock — enough for storage.ts and service-worker.ts
const chromeMock = {
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
    },
    session: {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    lastError: undefined as chrome.runtime.LastError | undefined,
    openOptionsPage: vi.fn(),
  },
};

Object.defineProperty(global, "chrome", { value: chromeMock, writable: true });

afterEach(() => {
  vi.clearAllMocks();
});
