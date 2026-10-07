---
"@routedock/routedock": patch
---

Parse real mppx `Authorization: Payment <base64url>` credentials: voucher signatures and payers are now captured (base64url-safe, DID `source` payers, legacy `credential=` still accepted), and only after the credential verifies — fixing dropped last_signature/payer fields that broke session recovery.
