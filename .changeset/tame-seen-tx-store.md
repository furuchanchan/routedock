---
'@routedock/sdk': patch
---

A failed `seenTxStore.set` after on-chain settlement no longer fails the request. The idempotency record only dedupes byte-identical retries — the funds have already moved when it is written, so a throwing store (e.g. a Supabase blip in `SupabaseSeenTxStore.set`) no longer drops a paid request into the 500 settlement-failure path on the Hono and Express/Fastify x402 and mpp-charge handlers. The failure is logged and reported through `onCallbackError` as `seenTxStore.set`, and `onSettled` and the route still run (#326).
