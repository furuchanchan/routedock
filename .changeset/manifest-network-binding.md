---
"@routedock/routedock": patch
---

Reject provider manifests whose `network` does not match the client's configured network at manifest-fetch time, so a mismatched provider fails with a typed manifest error before any mode selection or payment work.
