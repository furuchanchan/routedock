---
'@routedock/mcp-server': patch
---

`open_session` no longer sends vouchers to a provider's bare origin. The tool schema previously described `url` as the provider base URL, so `stream_session` issued GET /, paid a voucher, and hit a 404 — with `close_session` later settling the wasted vouchers on-chain. A bare origin is now resolved to an endpoint from the provider manifest (`endpoints.stream`, or the only advertised GET endpoint); resolutions that would leave the provider's origin are rejected, ambiguous manifests return an error listing every advertised endpoint, and the manifest fetch is shared with the `min_deposit` preflight so it runs at most once. The success payload now reports `endpoint_url` (#317).
