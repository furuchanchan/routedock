---
"@routedock/routedock": patch
---

Provider: route dual session transports correctly. With both mpp-session and mpp-session-ws enabled, non-x402 requests now dispatch by transport — WebSocket upgrades go to the ws handler, everything else to the session handler — so HTTP session traffic is no longer priced at the ws rate. The serving transport is recorded and reported to onSettled instead of always the primary mode, and advertising different channelFactory values for the two modes now throws at construction since they share one channel store.
