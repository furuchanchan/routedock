---
"@routedock/routedock": patch
---

fetchManifest now rejects manifests whose `routedock` major version exceeds the SDK-supported major (1.x) with `RouteDockClientVersionError` on both the fresh-fetch and cache-hit paths, so a future 2.x manifest is not silently interpreted as 1.x.
