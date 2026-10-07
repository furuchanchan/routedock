---
"@routedock/routedock": patch
---

Malformed manifests now surface typed errors instead of raw TypeError/Error/RangeError: assertManifestValid checks modes↔pricing consistency, deprecated_modes subset, and USDC decimal parsing of pricing fields; the schema gains StrKey patterns for payee/asset_contract/channel_factory and decimal patterns for amounts; verifyManifestSignature wraps an invalid payee in RouteDockSignatureError.
