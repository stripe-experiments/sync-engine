# Sigma Schema Artifacts

This directory holds the Stripe Sigma reporting schema snapshot and **generated** ingestion configs used for Stripe Sigma data ingestion.

## What’s here

- `schema_artifact.json`  
  Snapshot of Stripe’s reporting data schema.
- `sigmaIngestionConfigs.ts`  
  **Generated** configs for all tables that include primary keys.
- `fetch-schema.ts`  
  Script that downloads the schema and generates the artifacts above.

## Update flow

1. Run:

```bash
   npm run generate:sigma-schema
```

2. Review the generated artifacts.
3. Copy the configs you want to support into the **runtime** file:
   - `src/sigma/sigmaIngestionConfigs.ts`

> The runtime sync engine uses `src/sigma/sigmaIngestionConfigs.ts`, not the artifacts directly.

## Overrides / adjustments

Note that the generated config uses the Stripe Sigma schema to infer cursor columns for stable ordering and pagination. It is entirely possible that manual tweaks/adjustments are required amd that should be done before these configs are finally used at runtime.
