---
"@routedock/routedock": patch
---

Normalize `spendCap.endpointCaps` keys to their endpoint origin when the client is constructed, and reject keys that are not a bare origin or that collide after normalization, so a per-endpoint cap can no longer be silently inactive.
