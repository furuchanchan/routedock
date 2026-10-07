# Cloudflare Workers deployment

Provider A and Provider B are deployed as Workers. From the repository root:

```bash
pnpm install --frozen-lockfile
wrangler secret bulk apps/provider-a/.dev.vars
wrangler deploy --config apps/provider-a/wrangler.jsonc
wrangler secret bulk apps/provider-b/.dev.vars
wrangler deploy --config apps/provider-b/wrangler.jsonc
```

Keep production secret files outside version control. Verify deployments with:

```bash
curl -fsS https://api-a.routedock.xyz/health
curl -fsS https://api-b.routedock.xyz/.well-known/routedock.json
```

## Database prerequisites

Apply `supabase/migrations` in order (`001` → `005`) against the project's
database.

Settlement retention depends on **pg_cron**: migration `005` enables the
extension when it is available (Supabase projects ship it) and registers the
daily `settlement-retention-cleanup` job at `03:00 UTC`. Confirm the job is
registered:

```sql
SELECT jobname, schedule, active FROM cron.job;
```

On an instance where pg_cron cannot be installed (e.g. plain Postgres
without `shared_preload_libraries`), `005` applies with a WARNING instead of
failing. In that case run the cleanup from an external scheduler instead:

```sql
SELECT cleanup_stale_settlements(7);
```
