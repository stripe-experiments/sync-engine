# PGlite Hook Test Specification

This document describes the expected behavior and test cases for the `usePGlite` hook.

## Test Environment Setup

```typescript
// Mock fetch for testing
global.fetch = jest.fn();

// Mock PGlite
jest.mock('@electric-sql/pglite', () => ({
  PGlite: {
    create: jest.fn(() => ({
      query: jest.fn(),
      exec: jest.fn(),
    })),
  },
}));
```

## Test Cases

### 1. Initialization Flow

#### Test: Should start in 'idle' state
```typescript
const { result } = renderHook(() => usePGlite());

expect(result.current.status).toBe('idle');
expect(result.current.db).toBe(null);
expect(result.current.error).toBe(null);
expect(result.current.manifest).toBe(null);
```

#### Test: Should fetch manifest on mount
```typescript
const mockManifest = {
  timestamp: '2026-03-11T08:00:00.000Z',
  totalTables: 24,
  coreTables: ['customers', 'subscriptions'],
  // ...
};

fetch.mockResolvedValueOnce({
  ok: true,
  json: async () => mockManifest,
});

const { result, waitForNextUpdate } = renderHook(() => usePGlite());

await waitForNextUpdate();

expect(fetch).toHaveBeenCalledWith('/explorer-data/manifest.json');
expect(result.current.manifest).toEqual(mockManifest);
```

#### Test: Should transition to 'loading' during initialization
```typescript
const { result } = renderHook(() => usePGlite());

// Immediately after mount
expect(result.current.status).toBe('loading');
```

#### Test: Should transition to 'ready' after successful hydration
```typescript
// Mock successful fetch sequence
fetch
  .mockResolvedValueOnce({ ok: true, json: async () => mockManifest })
  .mockResolvedValueOnce({ ok: true, method: 'HEAD' }) // bootstrap.sql exists
  .mockResolvedValueOnce({ ok: true, text: async () => 'SELECT 1;' });

const { result, waitForNextUpdate } = renderHook(() => usePGlite());

await waitForNextUpdate();

expect(result.current.status).toBe('ready');
expect(result.current.db).not.toBe(null);
expect(result.current.error).toBe(null);
```

### 2. Error Handling

#### Test: Should handle manifest fetch failure
```typescript
fetch.mockResolvedValueOnce({
  ok: false,
  status: 404,
  statusText: 'Not Found',
});

const { result, waitForNextUpdate } = renderHook(() => usePGlite());

await waitForNextUpdate();

expect(result.current.status).toBe('error');
expect(result.current.error).toContain('Failed to fetch manifest: 404');
```

#### Test: Should handle missing bootstrap artifact
```typescript
fetch
  .mockResolvedValueOnce({ ok: true, json: async () => mockManifest })
  .mockResolvedValueOnce({ ok: false }) // bootstrap.sql not found
  .mockResolvedValueOnce({ ok: false }); // bootstrap.json not found

const { result, waitForNextUpdate } = renderHook(() => usePGlite());

await waitForNextUpdate();

expect(result.current.status).toBe('error');
expect(result.current.error).toContain('No data artifact found');
```

#### Test: Should handle PGlite initialization failure
```typescript
const { PGlite } = require('@electric-sql/pglite');
PGlite.create.mockRejectedValueOnce(new Error('WASM load failed'));

const { result, waitForNextUpdate } = renderHook(() => usePGlite());

await waitForNextUpdate();

expect(result.current.status).toBe('error');
expect(result.current.error).toContain('WASM load failed');
```

### 3. Query Execution

#### Test: Should reject queries when not ready
```typescript
const { result } = renderHook(() => usePGlite());

// Before initialization
await expect(
  result.current.query('SELECT 1')
).rejects.toThrow('Database not ready');
```

#### Test: Should execute queries when ready
```typescript
const mockResult = {
  rows: [{ id: 'cus_001', email: 'test@example.com' }],
  fields: [{ name: 'id' }, { name: 'email' }],
  rowCount: 1,
};

// Setup ready state
fetch
  .mockResolvedValueOnce({ ok: true, json: async () => mockManifest })
  .mockResolvedValueOnce({ ok: true })
  .mockResolvedValueOnce({ ok: true, text: async () => 'SELECT 1;' });

const { PGlite } = require('@electric-sql/pglite');
const mockDb = { query: jest.fn().mockResolvedValue(mockResult) };
PGlite.create.mockResolvedValue(mockDb);

const { result, waitForNextUpdate } = renderHook(() => usePGlite());
await waitForNextUpdate();

const queryResult = await result.current.query('SELECT * FROM customers');

expect(mockDb.query).toHaveBeenCalledWith('SELECT * FROM customers', undefined);
expect(queryResult).toEqual(mockResult);
```

#### Test: Should support parameterized queries
```typescript
const { result } = renderHook(() => usePGlite());
// ... wait for ready state

await result.current.query(
  'SELECT * FROM customers WHERE id = $1',
  ['cus_001']
);

expect(mockDb.query).toHaveBeenCalledWith(
  'SELECT * FROM customers WHERE id = $1',
  ['cus_001']
);
```

### 4. Exec Function

#### Test: Should execute commands without returning results
```typescript
const mockDb = { exec: jest.fn() };
// ... setup ready state with mockDb

await result.current.exec('CREATE TEMP TABLE test (id INT)');

expect(mockDb.exec).toHaveBeenCalledWith('CREATE TEMP TABLE test (id INT)');
```

#### Test: Should reject exec when not ready
```typescript
const { result } = renderHook(() => usePGlite());

await expect(
  result.current.exec('CREATE TABLE test (id INT)')
).rejects.toThrow('Database not ready');
```

### 5. Hydration Formats

#### Test: Should prefer SQL bootstrap over JSON
```typescript
fetch
  .mockResolvedValueOnce({ ok: true, json: async () => mockManifest })
  .mockResolvedValueOnce({ ok: true }) // bootstrap.sql HEAD check
  .mockResolvedValueOnce({ ok: true, text: async () => 'SELECT 1;' });

const { waitForNextUpdate } = renderHook(() => usePGlite());
await waitForNextUpdate();

// Should fetch SQL, not check for JSON
expect(fetch).toHaveBeenCalledWith('/explorer-data/bootstrap.sql', { method: 'HEAD' });
expect(fetch).toHaveBeenCalledWith('/explorer-data/bootstrap.sql');
expect(fetch).not.toHaveBeenCalledWith('/explorer-data/bootstrap.json');
```

#### Test: Should fallback to JSON if SQL not available
```typescript
fetch
  .mockResolvedValueOnce({ ok: true, json: async () => mockManifest })
  .mockResolvedValueOnce({ ok: false }) // bootstrap.sql not found
  .mockResolvedValueOnce({ ok: true }) // bootstrap.json HEAD check
  .mockResolvedValueOnce({
    ok: true,
    json: async () => ({ customers: [{ _raw_data: {}, _account_id: 'acct' }] })
  });

const { waitForNextUpdate } = renderHook(() => usePGlite());
await waitForNextUpdate();

expect(fetch).toHaveBeenCalledWith('/explorer-data/bootstrap.json', { method: 'HEAD' });
expect(fetch).toHaveBeenCalledWith('/explorer-data/bootstrap.json');
```

### 6. Lifecycle and Cleanup

#### Test: Should not initialize twice in strict mode
```typescript
const { rerender } = renderHook(() => usePGlite());

// Force re-render
rerender();

// Should only fetch manifest once
expect(fetch).toHaveBeenCalledTimes(1);
```

#### Test: Should handle unmount during initialization
```typescript
fetch.mockImplementation(() => new Promise(() => {})); // never resolves

const { unmount } = renderHook(() => usePGlite());

// Unmount before initialization completes
unmount();

// Should not throw or cause memory leaks
expect(true).toBe(true);
```

## Integration Tests

### Full End-to-End Flow

```typescript
describe('usePGlite integration', () => {
  it('should complete full initialization and query flow', async () => {
    // 1. Mock manifest
    const manifest = { /* ... */ };
    fetch.mockResolvedValueOnce({ ok: true, json: async () => manifest });

    // 2. Mock SQL bootstrap
    fetch.mockResolvedValueOnce({ ok: true }); // HEAD
    fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => `
        CREATE SCHEMA stripe;
        CREATE TABLE stripe.customers (id TEXT, _raw_data JSONB);
        INSERT INTO stripe.customers VALUES ('cus_001', '{"email":"test@example.com"}');
      `
    });

    // 3. Mock PGlite
    const mockDb = {
      exec: jest.fn(),
      query: jest.fn().mockResolvedValue({
        rows: [{ id: 'cus_001', email: 'test@example.com' }],
        rowCount: 1,
      }),
    };
    PGlite.create.mockResolvedValue(mockDb);

    // 4. Initialize hook
    const { result, waitForNextUpdate } = renderHook(() => usePGlite());

    // 5. Wait for ready
    await waitForNextUpdate();

    // 6. Verify ready state
    expect(result.current.status).toBe('ready');
    expect(result.current.manifest).toEqual(manifest);

    // 7. Execute query
    const queryResult = await result.current.query('SELECT * FROM stripe.customers');

    // 8. Verify result
    expect(queryResult.rows).toHaveLength(1);
    expect(queryResult.rows[0].email).toBe('test@example.com');
  });
});
```

## Manual Testing Checklist

- [ ] Hook initializes without errors in browser console
- [ ] Loading state shows before database is ready
- [ ] Manifest data is correctly parsed and exposed
- [ ] Query function executes SQL successfully
- [ ] Parameterized queries work with proper escaping
- [ ] Error states display helpful messages
- [ ] No memory leaks on component unmount
- [ ] Works in Next.js development mode (with hot reload)
- [ ] Works in Next.js production build
- [ ] Bootstrap artifact loads efficiently (<5 seconds)
- [ ] Multiple components can share the same database instance

## Performance Benchmarks

Target performance metrics:

- **Initialization time:** <3 seconds for 10MB artifact
- **First query latency:** <100ms
- **Subsequent queries:** <50ms
- **Memory usage:** <100MB for typical dataset
- **Network transfer:** <3MB (gzipped)

## Browser Compatibility

Required browser features:
- WebAssembly support
- IndexedDB (for PGlite persistence)
- ES2020+ JavaScript features
- Fetch API

Minimum supported browsers:
- Chrome 87+
- Firefox 78+
- Safari 14+
- Edge 88+
