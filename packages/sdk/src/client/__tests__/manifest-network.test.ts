/**
 * Tests for manifest network binding (#399).
 *
 * The SDK signs and pays on its own configured network regardless of what the
 * provider's manifest declares. A manifest whose `network` does not match the
 * caller's expected network must be rejected at manifest-fetch time, before
 * any mode selection or payment work — a mainnet client pointed at a
 * testnet-declared provider would otherwise submit a real payment, and a
 * testnet client at a mainnet manifest would fail deep inside mppx with an
 * opaque error.
 *
 * Mirrors manifest-cache.test.ts: a real local HTTP server serves a signed
 * manifest; no testnet/mainnet RPC calls are made.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import * as http from 'node:http'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest, invalidateManifest } from '../ModeRouter.js'
import { RouteDockManifestError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest } from '../../types.js'

const signingKey = Keypair.random()

function createManifest(network: 'testnet' | 'mainnet'): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Network Test Provider',
    description: 'Manifest used to verify client/manifest network binding',
    modes: ['x402'],
    network,
    asset: 'USDC',
    asset_contract: 'CTESTASSETCONTRACT',
    payee: signingKey.publicKey(),
    pricing: {
      x402: {
        amount: '1.00',
        per: 'request',
        facilitator: 'https://facilitator.example',
      },
    },
    endpoints: {
      price: {
        method: 'GET',
        path: '/price',
      },
    },
    tags: ['test'],
  }
}

function startManifestServer(
  manifest: RouteDockManifest,
): Promise<{ baseUrl: string; hits: { count: number }; close: () => Promise<void> }> {
  const signed = signManifest(manifest, signingKey.secret())
  return new Promise((resolve) => {
    const hits = { count: 0 }
    const server = http.createServer((_req, res) => {
      hits.count += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(signed))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        hits,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

// ── Fresh fetch: mismatched network is rejected before mode selection ────────

{
  const server = await startManifestServer(createManifest('testnet'))
  try {
    invalidateManifest(server.baseUrl)
    await assert.rejects(
      fetchManifest(server.baseUrl, undefined, undefined, undefined, 'mainnet'),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockManifestError)
        assert.match(err.message, /declares network 'testnet'/)
        assert.match(err.message, /'mainnet'/)
        return true
      },
    )
    console.log('✓ testnet manifest rejected for a mainnet-configured caller')
  } finally {
    await server.close()
  }
}

// ── Reverse direction: mainnet manifest vs testnet caller ────────────────────

{
  const server = await startManifestServer(createManifest('mainnet'))
  try {
    invalidateManifest(server.baseUrl)
    await assert.rejects(
      fetchManifest(server.baseUrl, undefined, undefined, undefined, 'testnet'),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockManifestError)
        assert.match(err.message, /declares network 'mainnet'/)
        assert.match(err.message, /'testnet'/)
        return true
      },
    )
    console.log('✓ mainnet manifest rejected for a testnet-configured caller')
  } finally {
    await server.close()
  }
}

// ── Matching network passes; unspecified expectation stays permissive ────────

{
  const server = await startManifestServer(createManifest('testnet'))
  try {
    invalidateManifest(server.baseUrl)
    const matched = await fetchManifest(server.baseUrl, undefined, undefined, undefined, 'testnet')
    assert.equal(matched.network, 'testnet')

    invalidateManifest(server.baseUrl)
    const unbound = await fetchManifest(server.baseUrl)
    assert.equal(unbound.network, 'testnet')
    console.log('✓ matching network accepted; omitted expectation stays permissive')
  } finally {
    await server.close()
  }
}

// ── Cache hit still enforces the per-caller network binding ──────────────────

{
  const server = await startManifestServer(createManifest('testnet'))
  try {
    invalidateManifest(server.baseUrl)
    const hitsBefore = server.hits.count
    await fetchManifest(server.baseUrl, undefined, undefined, undefined, 'testnet')
    assert.equal(server.hits.count, hitsBefore + 1)

    // Second caller (different expected network) hits the warm cache — the
    // binding is per-caller like expectedPayee and must still reject.
    await assert.rejects(
      fetchManifest(server.baseUrl, undefined, undefined, undefined, 'mainnet'),
      RouteDockManifestError,
    )
    assert.equal(server.hits.count, hitsBefore + 1)

    // Same-network caller still gets the cached manifest.
    const cached = await fetchManifest(server.baseUrl, undefined, undefined, undefined, 'testnet')
    assert.equal(cached.network, 'testnet')
    assert.equal(server.hits.count, hitsBefore + 1)
    console.log('✓ network binding enforced on cache hits without re-fetching')
  } finally {
    await server.close()
  }
}
