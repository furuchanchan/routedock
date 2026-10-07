/**
 * Tests for budget_per_request on the default selection path (#403).
 *
 * Before this fix `budget_per_request` was only read inside the
 * `optimize: 'cost'` branch, so a caller who set a per-request ceiling on the
 * default path silently paid over it — the exact outcome #147 added the
 * budget rejection to prevent.
 *
 * selectMode is pure: manifests are built in-memory, no network or signing.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { selectMode } from '../ModeRouter.js'
import { RouteDockNoSupportedModeError, RouteDockPolicyRejectError } from '../../errors.js'
import type { RouteDockManifest } from '../../types.js'

function createManifest(modes: string[], amounts: Record<string, string>): RouteDockManifest {
  const pricing: Record<string, { amount: string; per: string; facilitator: string }> = {}
  for (const mode of modes) {
    pricing[mode] = {
      amount: amounts[mode] ?? '0.01',
      per: 'request',
      facilitator: 'https://facilitator.example',
    }
  }
  return {
    routedock: '1.0',
    name: 'Budget Test Provider',
    description: 'Manifest used to verify default-path budget enforcement',
    modes: modes as RouteDockManifest['modes'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CTESTASSETCONTRACT',
    payee: 'GPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAYEEPAY',
    pricing,
    endpoints: {
      price: {
        method: 'GET',
        path: '/price',
      },
    },
    tags: ['test'],
  }
}

// ── Default path: advertised price above the ceiling is rejected ─────────────

{
  const manifest = createManifest(['mpp-charge'], { 'mpp-charge': '0.01' })
  assert.throws(
    () => selectMode(manifest, { budget_per_request: '0.001' }),
    (err: unknown) => {
      assert.ok(err instanceof RouteDockPolicyRejectError)
      assert.match(err.message, /budget_per_request_exceeded/)
      return true
    },
  )
  console.log('✓ over-budget per-request price rejected on the default path')
}

// ── Default path: an affordable advertised mode is still selected ────────────

{
  const manifest = createManifest(['mpp-charge', 'x402'], {
    'mpp-charge': '0.01',
    x402: '0.0005',
  })
  // Preference order stays mpp-charge → x402: the first affordable entry wins.
  const mode = selectMode(manifest, { budget_per_request: '0.001' })
  assert.equal(mode, 'x402')
  console.log('✓ first affordable per-request mode wins on the default path')
}

// ── Default path: price within the ceiling is unchanged behavior ─────────────

{
  const manifest = createManifest(['mpp-charge'], { 'mpp-charge': '0.001' })
  assert.equal(selectMode(manifest, { budget_per_request: '0.001' }), 'mpp-charge')
  console.log('✓ within-budget default selection unchanged')
}

// ── No budget configured: default path keeps its preference order ────────────

{
  const manifest = createManifest(['mpp-charge', 'x402'], {
    'mpp-charge': '0.01',
    x402: '0.0005',
  })
  assert.equal(selectMode(manifest, {}), 'mpp-charge')
  console.log('✓ no budget → unchanged preference order')
}

// ── Session-only manifests are unaffected by a per-request ceiling ───────────

{
  const manifest = createManifest(['mpp-session'], {})
  assert.throws(
    () => selectMode(manifest, { budget_per_request: '0.001' }),
    RouteDockNoSupportedModeError,
  )
  console.log('✓ session-only manifest does not synthesize a per-request mode')
}
