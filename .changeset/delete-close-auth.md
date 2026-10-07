---
"@routedock/routedock": patch
---

Provider: authenticate channel close. DELETE on an mpp-session route now goes through the same mppx voucher verification as data requests in both the Hono and Express adapters — an unauthenticated or foreign-channel DELETE is rejected instead of force-closing the channel, and malformed `amount` bodies return a 400 JSON error instead of a 500.
