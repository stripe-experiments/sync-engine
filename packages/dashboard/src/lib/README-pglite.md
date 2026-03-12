# PGlite Database Hydration Hook

Client-side Postgres database powered by PGlite (WASM) for the Stripe Schema Explorer.

## Overview

The `usePGlite()` hook initializes a browser-based Postgres database and hydrates it with Stripe schema data from static artifacts. This enables fully client-side SQL exploration without backend API calls.

## Usage

### Basic Hook Usage

```tsx
import { usePGlite } from '@/lib/pglite';

function ExplorerComponent() {
  const { db, status, error, query, manifest } = usePGlite();

  if (status === 'loading') {
    return <div>Loading database...</div>;
  }

  if (status === 'error') {
    return <div>Error: {error}</div>;
  }

  // Database is ready, execute queries
  const handleQuery = async () => {
    const result = await query('SELECT * FROM stripe.customers LIMIT 10');
    console.log(result.rows);
  };

  return (
    <div>
      <h2>Schema Explorer</h2>
      <p>Tables: {manifest?.totalTables}</p>
      <button onClick={handleQuery}>Load Customers</button>
    </div>
  );
}
```

### Direct Query Execution

```tsx
const { query } = usePGlite();

// Simple query
const customers = await query('SELECT * FROM stripe.customers LIMIT 10');

// Parameterized query
const customer = await query(
  'SELECT * FROM stripe.customers WHERE id = $1',
  ['cus_seed_001']
);

// Join query
const subscriptions = await query(`
  SELECT
    s.id,
    s._raw_data->>'status' as status,
    c._raw_data->>'email' as customer_email
  FROM stripe.subscriptions s
  JOIN stripe.customers c ON s._raw_data->>'customer' = c.id
  LIMIT 20
`);
```

### Exec for Non-Query Commands

```tsx
const { exec } = usePGlite();

// Create temporary table
await exec(`
  CREATE TEMP TABLE analysis AS
  SELECT
    _raw_data->>'status' as status,
    COUNT(*) as count
  FROM stripe.subscriptions
  GROUP BY _raw_data->>'status'
`);
```

### Accessing Manifest Metadata

```tsx
const { manifest } = usePGlite();

if (manifest) {
  console.log('Total tables:', manifest.totalTables);
  console.log('Core tables:', manifest.coreTables);
  console.log('Row counts:', manifest.manifest);

  // List all tables with data
  Object.entries(manifest.manifest).forEach(([table, count]) => {
    console.log(`${table}: ${count} rows`);
  });
}
```

## Data Artifact Formats

The hook supports two bootstrap formats:

### 1. SQL Bootstrap (Preferred)

**File:** `/explorer-data/bootstrap.sql`

- Most efficient format
- Direct SQL execution
- Includes schema creation and data inserts
- Recommended for production

**Example:**
```sql
CREATE SCHEMA stripe;

CREATE TABLE stripe.customers (
  id TEXT PRIMARY KEY,
  _raw_data JSONB NOT NULL,
  _account_id TEXT NOT NULL,
  ...
);

INSERT INTO stripe.customers VALUES (...);
```

### 2. JSON Bootstrap (Fallback)

**File:** `/explorer-data/bootstrap.json`

- JSON array format per table
- Reconstructs INSERT statements client-side
- Easier to generate programmatically
- Larger file size

**Example:**
```json
{
  "customers": [
    {
      "_raw_data": {"id": "cus_seed_001", "email": "test@example.com", ...},
      "_account_id": "acct_seed_001"
    }
  ],
  "subscriptions": [...]
}
```

## Architecture

### Initialization Flow

1. **Fetch Manifest** (`/explorer-data/manifest.json`)
   - Discovers available tables
   - Gets row counts and metadata
   - Validates data completeness

2. **Discover Bootstrap Artifact**
   - Checks for `bootstrap.sql` (preferred)
   - Falls back to `bootstrap.json`
   - Throws error if neither exists

3. **Initialize PGlite**
   - Creates WASM Postgres instance
   - Loads in browser memory
   - ~3-5MB initial overhead

4. **Hydrate Database**
   - Executes SQL or reconstructs from JSON
   - Creates schema and tables
   - Inserts seed data
   - Logs progress

5. **Ready State**
   - Exposes `query()` and `exec()` functions
   - Database fully functional
   - No server dependency

### Status States

| Status | Description |
|--------|-------------|
| `idle` | Hook mounted, not started |
| `loading` | Fetching artifacts and initializing |
| `ready` | Database hydrated and ready for queries |
| `error` | Initialization failed, check `error` field |

## Performance Considerations

### Artifact Size Budget

- **Target:** <10MB compressed artifact
- **Maximum:** <3MB initial load (lazy hydration recommended for 100+ tables)
- **Compression:** Use gzip for `.sql` files

### Optimization Tips

1. **Lazy Hydration**
   - Load only top 30 tables initially
   - Hydrate remaining tables on-demand
   - Use manifest to prioritize high-frequency tables

2. **Query Performance**
   - PGlite runs in WASM - queries are fast but not production-speed
   - Avoid full table scans on large tables
   - Use indexed columns (PK, FK)

3. **Memory Management**
   - PGlite uses browser memory
   - ~10-50MB typical working set
   - Close unused connections

## Standalone Usage (Non-React)

```typescript
import { createPGliteDatabase } from '@/lib/pglite';

// Initialize without hooks
const { db, manifest } = await createPGliteDatabase();

// Execute queries
const result = await db.query('SELECT * FROM stripe.customers LIMIT 5');
console.log(result.rows);
```

## Error Handling

```tsx
const { status, error, query } = usePGlite();

// Handle initialization errors
if (status === 'error') {
  console.error('Failed to initialize:', error);
  // Display user-friendly message
  return <ErrorState message={error} />;
}

// Handle query errors
try {
  const result = await query('SELECT * FROM invalid_table');
} catch (err) {
  console.error('Query failed:', err);
  // Handle query-specific error
}
```

## Common Issues

### Missing Artifact Files

**Error:** `No data artifact found`

**Fix:** Ensure `/public/explorer-data/bootstrap.sql` or `bootstrap.json` exists

### PGlite Not Installed

**Error:** `Cannot find module '@electric-sql/pglite'`

**Fix:**
```bash
cd packages/dashboard
npm install @electric-sql/pglite
```

### Large Artifact Size

**Error:** Browser hangs during load

**Fix:**
- Reduce seeded row counts
- Implement lazy hydration
- Use SQL format instead of JSON

### Query Syntax Errors

**Error:** `syntax error at or near ...`

**Fix:**
- PGlite uses Postgres SQL syntax
- Check for typos in table/column names
- Use schema prefix: `stripe.table_name`

## Development Workflow

### 1. Generate Seed Data

```bash
pnpm explorer:db:start  # Start Docker Postgres
pnpm explorer:migrate   # Run migrations
pnpm explorer:seed      # Seed with deterministic data
```

### 2. Export Artifacts

```bash
# Export SQL (recommended)
pnpm explorer:export:sql

# Or export JSON
pnpm explorer:export:json
```

### 3. Copy to Public Directory

```bash
cp .tmp/explorer-bootstrap.sql packages/dashboard/public/explorer-data/bootstrap.sql
cp .tmp/seed-manifest.json packages/dashboard/public/explorer-data/manifest.json
```

### 4. Test in Browser

```bash
cd packages/dashboard
pnpm dev
# Open http://localhost:3000 and check console
```

## API Reference

### `usePGlite()`

React hook for PGlite database initialization.

**Returns:**
```typescript
{
  db: PGliteInstance | null;      // Raw PGlite instance
  status: DatabaseStatus;          // 'idle' | 'loading' | 'ready' | 'error'
  error: string | null;            // Error message if failed
  query: (sql, params?) => Promise<QueryResult>;
  exec: (sql) => Promise<void>;
  manifest: ExplorerManifest | null;
}
```

### `createPGliteDatabase()`

Standalone initialization function (non-React).

**Returns:**
```typescript
Promise<{
  db: PGliteInstance;
  manifest: ExplorerManifest;
}>
```

### Types

```typescript
interface QueryResult {
  rows: any[];
  fields: { name: string; dataTypeID: number }[];
  rowCount: number;
}

interface ExplorerManifest {
  timestamp: string;
  seed: number;
  apiVersion: string;
  totalTables: number;
  coreTables: string[];
  longTailTables: string[];
  manifest: Record<string, number>;
  failedTables: Array<{ table: string; reason: string }>;
  verification: {
    allTablesSeeded: boolean;
    tablesWithData: number;
    emptyTables: string[];
  };
}
```

## Next Steps

1. **Install PGlite:** `npm install @electric-sql/pglite`
2. **Generate Export Script:** Create `scripts/explorer-export.ts`
3. **Build Explorer UI:** Create components using `usePGlite()`
4. **Optimize Artifacts:** Implement compression and lazy loading

## References

- [PGlite Documentation](https://github.com/electric-sql/pglite)
- [Explorer Seed Script](../../../scripts/explorer-seed.ts)
- [Explorer Migration Script](../../../scripts/explorer-migrate.ts)
