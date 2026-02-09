# API Version Management Guide

This guide explains how to work with Stripe API versions in the sync engine, which uses OpenAPI specifications to dynamically generate database schemas.

## Overview

The Stripe Sync Engine uses OpenAPI specifications as the source of truth for database schema generation. This approach provides:

- **Version-driven schemas**: Database tables are generated from the OpenAPI spec you specify
- **Automatic updates**: When Stripe publishes new API versions, update your spec and regenerate schemas
- **No hardcoded assumptions**: All schema information comes from the OpenAPI specification

## How Stripe Versions Their API

Stripe versions their API by date (e.g., `2024-12-18`, `2024-10-28`). The OpenAPI specifications represent the API structure at the time of publication.

### Available OpenAPI Specs

The sync engine works with OpenAPI specs located in `/pay/src/openapi/`:

- `latest/openapi.spec3.json` - Latest API version
- `latest/openapi.sdk.spec3.json` - SDK-optimized version with more detail
- `openapi/spec3.json` - Main specification file
- `openapi/spec3.sdk.json` - SDK specification
- Various versioned and beta specifications

## Basic Workflow

### 1. Choose Your API Version

Decide which Stripe API version you want to use:

```bash
# List available specs
ls /pay/src/openapi/latest/
ls /pay/src/openapi/openapi/

# Check spec version and info
sync-engine spec-info --spec=/pay/src/openapi/latest/openapi.spec3.json
```

### 2. Configure Your Sync

Create a configuration that specifies:
- Path to the OpenAPI spec file
- Which Stripe objects to sync
- Database connection details

```typescript
const config = {
  openApiSpecPath: '/pay/src/openapi/latest/openapi.spec3.json',
  stripeObjects: ['customer', 'charge', 'subscription'],
  databaseUrl: process.env.DATABASE_URL,
  schemaName: 'stripe' // optional, defaults to 'stripe'
};
```

### 3. Generate and Apply Schema

Run migrations to create tables based on your OpenAPI spec:

```bash
# Generate tables from OpenAPI spec
sync-engine migrate --spec=/pay/src/openapi/latest/openapi.spec3.json --objects=customer,charge,subscription

# Dry run to see what would be created
sync-engine migrate --spec=/pay/src/openapi/latest/openapi.spec3.json --objects=customer,charge --dry-run
```

## Updating to a New API Version

When Stripe releases a new API version:

### 1. Update Your OpenAPI Spec

Either:
- Use a newer spec file from `/pay/src/openapi/`
- Download the latest spec from Stripe's public repository

### 2. Validate Changes

Check what changes the new spec would make:

```bash
# See differences between current schema and new spec
sync-engine diff-schema --spec=/path/to/new-spec.json --existing-db=$DATABASE_URL

# Validate your object configurations against new spec
sync-engine validate-schemas --spec=/path/to/new-spec.json
```

### 3. Apply Schema Evolution

The sync engine supports safe schema evolution:

```bash
# Generate evolution statements (adds new columns)
sync-engine generate-evolution --objects=customer --spec=/path/to/new-spec.json --existing-db=$DATABASE_URL

# Apply the changes
sync-engine migrate --spec=/path/to/new-spec.json --objects=customer,charge,subscription
```

**Schema evolution rules:**
- New columns are added as nullable (safe)
- Existing columns are preserved
- No columns are dropped automatically
- Changes are logged with timestamps

## Version-Specific Schema Names

For managing multiple API versions, you can use version-specific schema names:

```typescript
const config = {
  openApiSpecPath: '/pay/src/openapi/latest/openapi.spec3.json',
  stripeObjects: ['customer', 'charge'],
  schemaName: 'stripe_v2024_12_18' // version-specific schema
};
```

This creates tables like:
- `stripe_v2024_12_18.customers`
- `stripe_v2024_12_18.charges`

## Best Practices

### 1. Version Tracking

Always track which API version you're using:

```bash
# Check current spec version
sync-engine spec-info --spec=/path/to/your-spec.json

# Document in your configuration
const config = {
  openApiSpecPath: '/pay/src/openapi/latest/openapi.spec3.json',
  apiVersion: '2024-12-18', // for documentation
  stripeObjects: ['customer', 'charge']
};
```

### 2. Testing New Versions

Before applying to production:

1. Test with a copy of your database
2. Run schema validation
3. Check for breaking changes
4. Verify your application code compatibility

```bash
# Test environment workflow
export TEST_DATABASE_URL="postgresql://localhost/test_db"

# Validate against new spec
sync-engine validate-schemas --spec=/path/to/new-spec.json

# Generate evolution preview
sync-engine generate-evolution --objects=customer --spec=/path/to/new-spec.json --existing-db=$TEST_DATABASE_URL

# Apply to test environment
sync-engine migrate --spec=/path/to/new-spec.json --objects=customer,charge --dry-run
```

### 3. Rollback Planning

Keep your previous OpenAPI spec files for rollback scenarios:

```bash
# Keep versioned copies
cp /pay/src/openapi/latest/openapi.spec3.json ./specs/stripe-spec-2024-12-18.json

# Document your current version
echo "2024-12-18" > ./current-api-version.txt
```

### 4. Gradual Migration

For large applications, migrate objects gradually:

```bash
# Start with less critical objects
sync-engine migrate --spec=/path/to/new-spec.json --objects=customer

# Add more objects after validation
sync-engine migrate --spec=/path/to/new-spec.json --objects=customer,product,price

# Complete with all objects
sync-engine migrate --spec=/path/to/new-spec.json --objects=customer,charge,subscription,payment_intent
```

## Configuration Examples

### Basic Configuration

```typescript
interface SyncConfig {
  openApiSpecPath: string;
  stripeObjects: string[];
  databaseUrl: string;
  schemaName?: string;
}

const basicConfig: SyncConfig = {
  openApiSpecPath: '/pay/src/openapi/latest/openapi.spec3.json',
  stripeObjects: ['customer', 'charge'],
  databaseUrl: process.env.DATABASE_URL!
};
```

### Multi-Version Configuration

```typescript
// Support multiple API versions simultaneously
const configs = [
  {
    openApiSpecPath: '/pay/src/openapi/openapi/spec3.json',
    stripeObjects: ['customer', 'charge'],
    schemaName: 'stripe_v2024_10_28'
  },
  {
    openApiSpecPath: '/pay/src/openapi/latest/openapi.spec3.json',
    stripeObjects: ['customer', 'charge'],
    schemaName: 'stripe_v2024_12_18'
  }
];
```

### Environment-Specific Configuration

```typescript
const getConfig = (environment: string) => ({
  openApiSpecPath: environment === 'production'
    ? '/pay/src/openapi/openapi/spec3.json'  // stable version
    : '/pay/src/openapi/latest/openapi.spec3.json', // latest for dev
  stripeObjects: ['customer', 'charge', 'subscription'],
  databaseUrl: process.env.DATABASE_URL!,
  schemaName: environment === 'production' ? 'stripe' : `stripe_${environment}`
});
```

## Troubleshooting

### Spec File Not Found

```bash
Error: Cannot load OpenAPI spec from /path/to/spec.json
```

**Solution**: Verify the file path and ensure the spec file exists:

```bash
ls -la /pay/src/openapi/latest/
# Use full absolute path or verify relative path from working directory
```

### Invalid Object Names

```bash
Error: Object "custmer" not found in OpenAPI spec
```

**Solution**: Check available objects in the spec:

```bash
sync-engine list-objects --spec=/path/to/spec.json
```

### Schema Evolution Conflicts

**Issue**: Column already exists errors during migration

**Solution**: The sync engine handles existing columns gracefully. If you see conflicts:

1. Check current database schema
2. Run with `--dry-run` first
3. Use schema diffing tools

```bash
# See what changes would be made
sync-engine diff-schema --spec=/path/to/spec.json --existing-db=$DATABASE_URL
```

### Performance Issues

**Issue**: Slow migration with large specs

**Solution**:
- Migrate objects incrementally
- Use specific object lists instead of 'all'
- Consider indexing strategies

```bash
# Instead of migrating all objects at once
sync-engine migrate --spec=/path/to/spec.json --objects=customer,charge  # smaller batch
```

## Related Documentation

- [Adding New Stripe Objects](adding-objects.md)
- [Schema Management](schema-management.md)
- [CLI Reference](cli-reference.md)
- [Migration Guide](migration-guide.md)