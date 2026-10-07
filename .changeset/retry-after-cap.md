---
'@routedock/routedock': patch
---

`RetryPolicy.maxDelayMs` now caps every retry sleep, including a server's `Retry-After` hint. Previously a 429/503 carrying `Retry-After: 86400` made `withRetry` sleep the raw value between attempts, so `fetchManifest`, `X402Client.pay`, `MppChargeClient.pay` and the session voucher/close calls could stall for days before rejecting. The clamped delay is what `onRetry` sees as `nextDelayMs`; the thrown error keeps the unclamped `retryAfterMs` so callers can still read the server's real hint (#323).
