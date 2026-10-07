---
'@routedock/sdk': patch
---

`MppChargeClient.pay` now returns the settlement hash in `txHash`. The client runs `@stellar/mpp` in pull mode, where the `'paid'` progress event never fires — the hash reaches the client only as the `Payment-Receipt` reference on the paid response, which is now parsed via `Receipt.fromResponse`. A missing or malformed receipt maps to `null` and never fails a request that was already paid (#324).
