---
"@routedock/routedock": minor
---

Provider adapters now fail fast at construction: each adapter validates its manifest against the JSON Schema and throws a `RouteDockManifestError` when the adapter options drift from the signed manifest — a served mode missing from `manifest.modes` (or vice versa), a price, asset, network, channel factory, or payee that disagrees, or a `payeeSecretKey` that does not belong to the manifest payee. Manifest schema validation moved into `manifest/validate.ts` and is exported for providers that want to pre-flight a manifest before wiring an adapter. (#328)
