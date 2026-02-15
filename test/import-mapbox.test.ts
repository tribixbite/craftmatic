import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock localStorage for token management tests
const mockStorage = new Map<string, string>();
const originalLocalStorage = globalThis.localStorage;

beforeEach(() => {
  mockStorage.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => mockStorage.get(key) ?? null,
      setItem: (key: string, value: string) => mockStorage.set(key, value),
      removeItem: (key: string) => mockStorage.delete(key),
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: originalLocalStorage,
    writable: true,
    configurable: true,
  });
});

async function loadModule() {
  const mod = await import('../web/src/ui/import-mapbox.js');
  return mod;
}

describe('Mapbox token management', () => {
  it('returns empty string when no token is stored', async () => {
    const { getMapboxToken, hasMapboxToken } = await loadModule();
    expect(getMapboxToken()).toBe('');
    expect(hasMapboxToken()).toBe(false);
  });

  it('stores and retrieves a token', async () => {
    const { getMapboxToken, setMapboxToken, hasMapboxToken } = await loadModule();
    setMapboxToken('pk.test-token-12345');
    expect(getMapboxToken()).toBe('pk.test-token-12345');
    expect(hasMapboxToken()).toBe(true);
  });

  it('trims whitespace from tokens', async () => {
    const { getMapboxToken, setMapboxToken } = await loadModule();
    setMapboxToken('  pk.spaces  ');
    expect(getMapboxToken()).toBe('pk.spaces');
  });

  it('removes token when empty string is set', async () => {
    const { getMapboxToken, setMapboxToken, hasMapboxToken } = await loadModule();
    setMapboxToken('pk.some-token');
    expect(hasMapboxToken()).toBe(true);
    setMapboxToken('');
    expect(hasMapboxToken()).toBe(false);
    expect(getMapboxToken()).toBe('');
  });
});

describe('createMapboxTileFetcher', () => {
  it('returns a function', async () => {
    const { createMapboxTileFetcher } = await loadModule();
    const fetcher = createMapboxTileFetcher('pk.test');
    expect(typeof fetcher).toBe('function');
  });
});

describe('MAPBOX_SIGNUP_URL', () => {
  it('points to Mapbox account signup', async () => {
    const { MAPBOX_SIGNUP_URL } = await loadModule();
    expect(MAPBOX_SIGNUP_URL).toContain('mapbox.com');
  });
});
