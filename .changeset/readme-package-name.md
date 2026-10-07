---
'@routedock/routedock': patch
---

The SDK README now uses the published package name, and the Session Lifecycle Hooks example compiles against the real callback signatures (`channelFactory`, `(channelId, voucherIndex, cumulativeAmount, signature)`, `onSettled` receiving no channel id). The Agent Usage example passes `commitmentSecret`, Mode Selection covers `transport: 'websocket'`, `optimize: 'cost'` with `budget_per_request`, and `deprecated_modes`, and new sections document `expectedPayee`, manifest caching with `invalidateManifest`, `estimateCost`/`preflight`, and `signature_version` 2. A repo guard rejects the unpublished name in verify and CI (#319).
