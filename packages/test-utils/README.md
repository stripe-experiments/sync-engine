# @stripe/sync-test-utils

Test utilities for Stripe list API integration:

- HTTP server that discovers listable Stripe objects from OpenAPI and proxies list calls to `stripe-mock`
- Postgres 18 Docker lifecycle helper (started automatically by default)
- DB seeding script that inserts OpenAPI-compliant list objects into Postgres

## Quick start

Start infrastructure:

```sh
docker compose up -d postgres stripe-mock
```

Run the server:

```sh
pnpm --filter @stripe/sync-test-utils build
pnpm --filter @stripe/sync-test-utils exec sync-test-utils-server
```

Seed the DB:

```sh
pnpm --filter @stripe/sync-test-utils exec sync-test-utils-seed-db
```

Seed with created timestamps spread across the last 5 years:

```sh
pnpm --filter @stripe/sync-test-utils exec sync-test-utils-seed-db --created-last-years 5
```

Or use explicit unix timestamp bounds:

```sh
pnpm --filter @stripe/sync-test-utils exec sync-test-utils-seed-db \
  --created-start-unix 1577836800 \
  --created-end-unix 1735689600
```

## Notes

- `stripe-mock` is expected at `http://localhost:12111` by default (`STRIPE_MOCK_URL` to override).
- If `POSTGRES_URL` is not provided, utilities start an internal `postgres:18` Docker container.
- Query filters for `GET /objects/:table` are validated against each endpoint's OpenAPI query parameters, including v2 endpoints.
- Seeding supports setting `created` timestamps over a range via `--created-last-years` or explicit start/end unix bounds.
