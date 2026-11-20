# Deployment (#144)

## Pipeline

1. **Verify** — CI jobs (contract sync, migrations, build, tests, Dockerfile build check, Helm lint).
2. **Image** — buildx pushes `ghcr.io/<repo-lowercase>@sha256:<digest>` from `Dockerfile`, cosign signs the digest, Syft emits an SPDX SBOM.
3. **Staging** — `deploy-env.yml` verifies the cosign identity, lints changed migrations, and runs `helm upgrade --install --atomic` using `deploy/helm/oracledesk-backend/`. A Helm `pre-install,pre-upgrade` Job runs `npx prisma migrate deploy` in-cluster from the release image digest.
4. **Staging checks** — readiness must hold 3 consecutive probes, every Deployment (`api`, `indexer`, `worker`) must run the release digest and complete rollout, indexer lag must be ≤ 120 ledgers, and the cursor must advance.
5. **Production** — same reusable workflow with the production GitHub Environment (required reviewers).
6. **Production checks** — 5 consecutive readiness probes plus the same digest, rollout, lag, cursor, and Prometheus checks.

Secrets (kubeconfig, Helm values) live in GitHub Environments; `values-*.yaml` never contain secret values (pods consume an existing Kubernetes Secret via `.Values.existingSecret`). The image is referenced by lowercase repository and digest, never by a mutable tag.

## Container Image & Process Roles (#272)

Build locally:

```bash
docker build -t oracledesk-backend:local .
```

The multi-stage `Dockerfile` builds on `node:22-bookworm-slim` (matching `.nvmrc`), generates the Prisma client for `["native", "debian-openssl-3.0.x"]`, ships `dist/`, production dependencies, `prisma/migrations`, and `tini`, and runs as non-root `node`.

`PROCESS_ROLE` splits the single image across three Kubernetes Deployments:

| Subsystem | `all` (default) | `api` | `indexer` | `worker` |
| --- | --- | --- | --- | --- |
| Secrets, embeddings, Prisma, Redis policy, spec-compat gate | ✓ | ✓ | ✓ | ✓ |
| HTTP API, Socket.IO, Redis fanout, RBAC bootstrap | ✓ | ✓ | | |
| Soroban event listener (`startEventListener`) | ✓ | | ✓ | |
| Outbox worker, cron jobs, sequence sync, saga resume | ✓ | | | ✓ |
| Probe-only HTTP server (`/livez`, `/readyz` only) | | | ✓ | ✓ |

Constraints:
- `PROCESS_ROLE=indexer` requires `INDEXER_ENABLED=true` and `EVENT_BUS_ENABLED=true` so indexed events reach `api` pods over Redis streams.
- `indexer` and `worker` Deployments run `replicas: 1` with `strategy: Recreate` until leader election lands.
- `helm upgrade --atomic` rolls back the Helm release on failure, while any completed pre-upgrade migration Job is not reverted (consistent with expand/contract).

## Migration rule: expand / contract

`scripts/check-migration-compat.mjs` (run on the migrations changed in a PR/release) blocks:

- `DROP TABLE`, `DROP COLUMN`, `RENAME`;
- `ALTER COLUMN … TYPE`;
- `SET NOT NULL`;
- `CREATE INDEX` without `CONCURRENTLY`.

Ship additive migrations first, deploy both versions, then remove old columns
in a later release. `--allow-breaking` exists only for an explicitly approved
maintenance window.

## Admin RBAC first deploy (#49)

Ship the `20261019110000_admin_rbac` migration before the new image. On first
boot the process seeds the fixed permission/role catalogue and assigns every
`ADMIN_ADDRESSES` entry as `super_admin` under an advisory lock. After that the
database is authoritative: removing an address from the environment does **not**
revoke it, and the env list is never consulted per request. Grant/revoke and
treasury writes require a wallet proof no older than `STEP_UP_MAX_AGE_SECONDS`.
If the seed cannot complete, the process refuses to boot rather than serve
without an admin role catalogue.

## Payment intent confirmer (#52)

`startPaymentIntentCron` runs every `PAYMENT_INTENT_CONFIRM_CRON` (default
`*/20 * * * * *`) and uses the same per-hash advisory lock as the legacy unlock,
so all replicas can schedule it safely. It is bounded by
`PAYMENT_INTENT_CONFIRM_BATCH` and backs off up to
`PAYMENT_INTENT_MAX_ATTEMPTS`. Set `PAYMENT_INTENT_CONFIRM_ENABLED=false` to
pause it without blocking interactive `POST /…/submit` calls.

## Rollback

Roll back the Helm release to the previous revision. If the new release added
only expand-phase changes, the old code keeps working. Do **not** roll back the
database; forward-fix instead.

## Post-deploy checks

```bash
API_URL=https://api.example \
INDEXER_STATUS_URL=https://api.example/internal/indexer-status \
MAX_INDEXER_LAG_LEDGERS=120 \
PROMETHEUS_URL=https://prometheus.example \
KUBE_NAMESPACE=oracledesk DEPLOYMENTS="api indexer worker" \
DIGEST=<sha256> ./scripts/post-deploy-checks.sh
```

Checks are read-only. `SKIP_KUBE=1` omits the digest check in local tests.

## Configuration lifecycle (#243)

`src/config/index.ts` (`envObjectSchema`) is the single list of variables the
backend accepts. Keys that nothing reads are classified in
`src/config/meta.ts` (`KEY_LIFECYCLE`):

| Status | Meaning | Boot behavior when set |
| ------ | ------- | ---------------------- |
| `active` (default) | Read by the code | — |
| `reserved` | Feature not landed (e.g. `KEEPER_*`, `SSE_*`, `RESOLUTION_ATTESTATION_*`, `X402_FACILITATOR_*`) | Warns "has no effect in this version" |
| `deprecated` | Scheduled for removal after `removeAfter` | Warns; if `replacedBy` is set and unset in env, the old value is mapped to the new key for one release |

Boot also warns about an unknown variable in one of the app's prefix families
(`CHANNEL_`, `KEEPER_`, `X402_`, ...) or within edit distance 2 of a schema key,
with a suggestion (`CHANEL_LEASE_MS` → `CHANNEL_LEASE_MS`). `<SECRET>_FILE`
variants of secret names are accepted. Warnings use `console.warn` once per
key and are silent under `NODE_ENV=test`.

Set `CONFIG_STRICT=true` to make any of these warnings fail boot with a
`ConfigError` instead. Recommended for production once the warnings are clean.

`npm run check:config` (`scripts/check-config-usage.ts`, TypeScript compiler
API over `src/`, `scripts/` and `prisma/`) reports keys read but not declared,
`active` keys never read, and `config as any` access. Reads inside
`src/config/index.ts` (including `superRefine` cross-checks) do not count as
usage.

## SEP-7 `stellar.toml` Hosting (#270)

When `URI_REQUEST_SIGNING_SECRET` is configured, the backend serves a minimal
SEP-7 `/.well-known/stellar.toml` (`NETWORK_PASSPHRASE` and
`URI_REQUEST_SIGNING_KEY`, `Content-Type: text/plain`,
`Access-Control-Allow-Origin: *`). Wallets fetch this file from
`https://<SEP7_ORIGIN_DOMAIN>/.well-known/stellar.toml`; if the API runs on a
subdomain, add an edge reverse-proxy rule on `SEP7_ORIGIN_DOMAIN` forwarding
`/.well-known/stellar.toml` to the backend. See
`docs/runbooks/treasury-sep7.md` for key rotation steps.

## IPFS Multi-Provider Replication & Hedged Gateways (#271)

Configure redundant pinning via `IPFS_PROVIDERS` (`pinata`, `kubo`, `psa`),
`IPFS_KUBO_API_URL` / `IPFS_KUBO_AUTH`, `IPFS_PSA_ENDPOINT` / `IPFS_PSA_TOKEN`,
and `IPFS_MIN_REPLICAS` (required to be `>= 2` in production). All pinned JSON
documents are capped at `IPFS_SINGLE_BLOCK_MAX` (256 KiB) so every provider
produces the identical CIDv1 raw/sha2-256 digest (`cidForBytes`). Reads use
health-scored hedged gateways (`IPFS_GATEWAYS`, `IPFS_HEDGE_DELAY_MS`) and
verify bytes before accepting them. Local `ipfs_content` rows are never evicted
while any `ipfs_pins` entry is not `PINNED`, and `GET /api/v1/admin/status`
exposes the live replication summary.

## Migrations

### Naming convention

Every new migration folder must start with a 14-digit timestamp prefix (`YYYYMMDDHHMMSS`) followed by `_` and a descriptive slug, e.g. `20261019140000_payment_intents`. The prefix must be **strictly greater** than every existing prefix. Duplicate prefixes break Prisma's lexical ordering and are caught by `npm run lint:migrations`.

### Checking for drift

`npm run check:drift` applies all migrations to a shadow database, then diffs in both directions between the applied schema and `prisma/schema.prisma`. It fails if any object appears in one side but not the other and is not listed in `prisma/drift-allowlist.json`.

Run locally:

```bash
# auto-creates oracledesk_shadow_<pid> and drops it on exit
DATABASE_URL=postgresql://... npm run check:drift

# or supply your own shadow DB
DATABASE_URL=postgresql://... SHADOW_DATABASE_URL=postgresql://...shadow npm run check:drift
```

### Drift allowlist (`prisma/drift-allowlist.json`)

Objects intentionally managed outside the datamodel (HNSW indexes, partial uniques, the `vector` extension) are listed here with a `reason`. Temporary entries carry an `expires` date; `check:drift` fails once that date has passed to prevent exemptions from going stale.

### Renumbering collision prefixes

The `prisma/migration-renames.json` map lists all historical prefix collisions and their unique replacements. Before deploying to a fresh environment or after a restore, run:

```bash
# Update _prisma_migrations rows (idempotent — safe to run twice)
DATABASE_URL=postgresql://... node scripts/renumber-migrations.mjs --apply-db

# Then rename the folders (only needed once per checkout)
node scripts/renumber-migrations.mjs --apply-fs
```

**Rollback:** swap `from` and `to` in the map and re-run `--apply-db` on the database, then `--apply-fs` on the checkout. The file contents (and their checksums) are unchanged, so Prisma's integrity check is unaffected.

**Order matters:** run `--apply-db` _before_ `prisma migrate deploy` so the applied-name rows match the folder names.
