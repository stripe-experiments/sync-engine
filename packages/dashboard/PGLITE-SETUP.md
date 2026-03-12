# PGlite Setup Guide

This guide walks through setting up the PGlite-based schema explorer for client-side SQL querying.

## Prerequisites

- Node.js 18+ with pnpm
- Docker (for seed data generation)

## Installation

### 1. Install PGlite Dependency

```bash
cd packages/dashboard
pnpm add @electric-sql/pglite
```

### 2. Verify File Structure

The following files should exist:

```
packages/dashboard/
├── src/
│   ├── lib/
│   │   ├── pglite.ts              # Main hook implementation ✓
│   │   └── README-pglite.md       # Documentation ✓
│   └── components/
│       └── ExplorerExample.tsx    # Example component ✓
└── public/
    └── explorer-data/
        ├── manifest.json           # Table metadata ✓
        └── bootstrap.sql           # Database dump (placeholder)
```

## Generate Production Data

### Step 1: Start Postgres Harness

```bash
# From project root
pnpm explorer:db:start
```

This creates an isolated Docker Postgres container with a random port.

### Step 2: Run Migrations

```bash
pnpm explorer:migrate
```

Creates all tables in `runtime_required` mode.

### Step 3: Seed Data

```bash
pnpm explorer:seed
```

Generates deterministic synthetic Stripe data:
- 16 core tables with graph-aware relationships
- 8+ long-tail tables with generic data
- ~300 total rows across all tables

**Output:**
- `.tmp/seed-manifest.json` - Table metadata and row counts

### Step 4: Export Bootstrap Artifact

**Option A: SQL Export (Recommended)**

```bash
# TODO: Create explorer-export.ts script
pnpm explorer:export:sql
```

This should generate:
- `.tmp/explorer-bootstrap.sql` - Full SQL dump with schema + data
- Size target: <10MB compressed

**Option B: JSON Export (Fallback)**

```bash
# TODO: Create explorer-export.ts script
pnpm explorer:export:json
```

This should generate:
- `.tmp/explorer-bootstrap.json` - JSON data per table
- Format: `{ tableName: [{ _raw_data, _account_id }, ...] }`

### Step 5: Copy to Public Directory

```bash
# Copy manifest
cp .tmp/seed-manifest.json packages/dashboard/public/explorer-data/manifest.json

# Copy bootstrap (SQL or JSON)
cp .tmp/explorer-bootstrap.sql packages/dashboard/public/explorer-data/bootstrap.sql
# OR
cp .tmp/explorer-bootstrap.json packages/dashboard/public/explorer-data/bootstrap.json
```

### Step 6: Cleanup

```bash
pnpm explorer:db:stop
```

Removes the Docker container and temporary files.

## Usage in Components

### Basic Hook

```tsx
'use client';

import { usePGlite } from '@/lib/pglite';

export default function MyExplorer() {
  const { db, status, error, query, manifest } = usePGlite();

  if (status === 'loading') return <div>Loading...</div>;
  if (status === 'error') return <div>Error: {error}</div>;

  return <div>Database ready! {manifest?.totalTables} tables available</div>;
}
```

### Running Queries

```tsx
const { query } = usePGlite();

// Simple query
const customers = await query(`
  SELECT * FROM stripe.customers LIMIT 10
`);

// Parameterized query
const customer = await query(
  'SELECT * FROM stripe.customers WHERE id = $1',
  ['cus_seed_001']
);

// JSONB operations
const activeSubscriptions = await query(`
  SELECT
    id,
    _raw_data->>'status' as status,
    _raw_data->>'customer' as customer_id
  FROM stripe.subscriptions
  WHERE _raw_data->>'status' = 'active'
`);
```

## Development Workflow

### Quick Start

```bash
# Terminal 1: Generate data
pnpm explorer:db:start
pnpm explorer:migrate
pnpm explorer:seed
pnpm explorer:export:sql  # TODO: Implement
cp .tmp/explorer-bootstrap.sql packages/dashboard/public/explorer-data/bootstrap.sql
pnpm explorer:db:stop

# Terminal 2: Start dev server
cd packages/dashboard
pnpm dev
```

### Testing the Hook

1. Open http://localhost:3000
2. Check browser console for PGlite logs:
   - `[PGlite] Fetching manifest from /explorer-data/manifest.json`
   - `[PGlite] Found SQL bootstrap artifact`
   - `[PGlite] Database hydration complete`
   - `[PGlite] Ready for queries`

3. Open React DevTools and verify hook state:
   - `status: "ready"`
   - `error: null`
   - `manifest: { totalTables: 24, ... }`

### Using the Example Component

Add to your page:

```tsx
// app/explorer/page.tsx
import ExplorerExample from '@/components/ExplorerExample';

export default function ExplorerPage() {
  return <ExplorerExample />;
}
```

## Troubleshooting

### PGlite Not Found

**Error:**
```
Cannot find module '@electric-sql/pglite'
```

**Fix:**
```bash
cd packages/dashboard
pnpm add @electric-sql/pglite
```

### Missing Bootstrap Artifact

**Error:**
```
No data artifact found. Expected /explorer-data/bootstrap.sql or bootstrap.json
```

**Fix:**
1. Run seed + export workflow (see above)
2. Verify files exist in `public/explorer-data/`
3. Check Next.js is serving `/public` correctly

### Database Initialization Hangs

**Cause:** Bootstrap artifact too large (>50MB)

**Fix:**
1. Reduce row counts in `explorer-seed.ts`
2. Seed only core tables (skip long-tail)
3. Implement lazy hydration for remaining tables

### TypeScript Errors from PGlite

**Issue:** PGlite's own type definitions may show errors

**Workaround:**
- These are upstream type issues
- Don't affect runtime
- Use `// @ts-ignore` if needed for PGlite imports

### Query Syntax Errors

**Error:**
```
syntax error at or near "..."
```

**Fix:**
- PGlite uses Postgres SQL syntax
- Always use schema prefix: `stripe.table_name`
- Check column names in manifest
- Test queries in harness Postgres first:

```bash
pnpm explorer:db:start
psql $(cat .tmp/schema-explorer-run.json | jq -r .databaseUrl)
# Run test query
```

## Production Considerations

### Artifact Size Budget

- **Target:** <3MB initial load (gzipped)
- **Maximum:** <10MB for full dataset
- **Strategy:** Lazy hydration for 100+ tables

### Optimization Checklist

- [ ] Compress bootstrap.sql with gzip
- [ ] Configure Next.js to serve .gz files
- [ ] Implement streaming for large artifacts
- [ ] Add loading progress indicator
- [ ] Lazy-load long-tail tables on demand
- [ ] Cache PGlite instance in service worker

### Security Notes

- All data is **client-side** - no server state
- Bootstrap artifacts are **public** - don't include sensitive data
- Use **synthetic/anonymized** data for public explorers
- PGlite runs in **browser sandbox** - no file system access

## Next Steps

1. **Implement Export Script**
   - Create `scripts/explorer-export.ts`
   - Generate SQL dump from Postgres
   - Optimize for size (<10MB target)

2. **Build Explorer UI**
   - Table browser component
   - SQL query editor with syntax highlighting
   - Result table with pagination
   - Schema visualizer

3. **Add Advanced Features**
   - Query history persistence
   - Saved queries
   - Export results as CSV/JSON
   - Relationship graph visualization

## References

- [PGlite Documentation](https://github.com/electric-sql/pglite)
- [usePGlite Hook](./src/lib/pglite.ts)
- [Example Component](./src/components/ExplorerExample.tsx)
- [Seed Script](../../scripts/explorer-seed.ts)
