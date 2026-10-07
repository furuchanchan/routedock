---
"@routedock/routedock": patch
---

Enforce `budget_per_request` on the default mode-selection path: a manifest whose per-request prices all exceed the caller's ceiling is now rejected with `budget_per_request_exceeded` instead of silently paying over budget.
