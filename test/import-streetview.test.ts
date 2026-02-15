import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock localStorage for key management tests
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

// Dynamic import to ensure localStorage mock is in place
async function loadModule() {
  // Clear module cache to pick up fresh localStorage mock
  const mod = await import('../web/src/ui/import-streetview.js');
  return mod;
}

describe('Street View key management', () => {
  it('returns empty string when no key is stored', async () => {
    const { getStreetViewApiKey, hasStreetViewApiKey } = await loadModule();
    expect(getStreetViewApiKey()).toBe('');
    expect(hasStreetViewApiKey()).toBe(false);
  });

  it('stores and retrieves a key', async () => {
    const { getStreetViewApiKey, setStreetViewApiKey, hasStreetViewApiKey } = await loadModule();
    setStreetViewApiKey('test-key-12345');
    expect(getStreetViewApiKey()).toBe('test-key-12345');
    expect(hasStreetViewApiKey()).toBe(true);
  });

  it('trims whitespace from keys', async () => {
    const { getStreetViewApiKey, setStreetViewApiKey } = await loadModule();
    setStreetViewApiKey('  key-with-spaces  ');
    expect(getStreetViewApiKey()).toBe('key-with-spaces');
  });

  it('removes key when empty string is set', async () => {
    const { getStreetViewApiKey, setStreetViewApiKey, hasStreetViewApiKey } = await loadModule();
    setStreetViewApiKey('some-key');
    expect(hasStreetViewApiKey()).toBe(true);
    setStreetViewApiKey('');
    expect(hasStreetViewApiKey()).toBe(false);
    expect(getStreetViewApiKey()).toBe('');
  });
});

describe('getStreetViewUrl', () => {
  it('generates correct URL with default size', async () => {
    const { getStreetViewUrl } = await loadModule();
    const url = getStreetViewUrl(40.7128, -74.006, 'MY_KEY');
    expect(url).toBe('https://maps.googleapis.com/maps/api/streetview?size=600x400&location=40.7128,-74.006&key=MY_KEY');
  });

  it('generates correct URL with custom size', async () => {
    const { getStreetViewUrl } = await loadModule();
    const url = getStreetViewUrl(34.0522, -118.2437, 'KEY2', '400x300');
    expect(url).toContain('size=400x300');
    expect(url).toContain('location=34.0522,-118.2437');
    expect(url).toContain('key=KEY2');
  });
});

describe('STREETVIEW_SIGNUP_URL', () => {
  it('points to Google Cloud Console', async () => {
    const { STREETVIEW_SIGNUP_URL } = await loadModule();
    expect(STREETVIEW_SIGNUP_URL).toContain('console.cloud.google.com');
  });
});
