---
"@routedock/routedock": patch
---

Hono provider: route session requests by transport when both mpp-session and mpp-session-ws are enabled — WebSocket upgrades go to the ws handler, everything else to the session handler — so each request is priced at its own rate and onSettled reports the serving transport. Advertising different channelFactory values for the two transports now throws at construction (they share one channel store).
