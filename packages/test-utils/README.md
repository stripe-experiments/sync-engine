# @stripe/sync-test-utils

Test utilities for Stripe list API integration:

- HTTP server that discovers listable Stripe objects from OpenAPI and proxies list calls to `stripe-mock`
- Postgres 18 Docker lifecycle helper (started automatically by default)
- DB seeding via `seedTestDb()` — inserts OpenAPI-compliant list objects into Postgres programmatically

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

## Notes

- `stripe-mock` is expected at `http://localhost:12111` by default (`STRIPE_MOCK_URL` to override).
- If `POSTGRES_URL` is not provided, utilities start an internal `postgres:18` Docker container.
- Query filters for `GET /objects/:table` are validated against each endpoint's OpenAPI query parameters, including v2 endpoints.
- Seeding supports setting `created` timestamps over a range via options passed to `seedTestDb()`.
