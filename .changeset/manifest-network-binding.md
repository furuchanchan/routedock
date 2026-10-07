---
"@routedock/routedock": patch
---

SDK client: bind fetched manifests to the configured network — `fetchManifest` accepts an optional `expectedNetwork` enforced on both fresh-fetch and cache-hit paths (per-caller, like `expectedPayee`), and `RouteDockClient`/`ProviderRegistry` pass their resolved network so a mainnet client can no longer sign and pay against a testnet-declared manifest.
