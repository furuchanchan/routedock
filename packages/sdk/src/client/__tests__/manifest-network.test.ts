/**
 * fetchManifest network binding (#399).
 *
 * The client never compared `manifest.network` with its configured network:
 * a mainnet client pointed at a testnet-declared provider (staging URL,
 * misrouted registry entry) would sign and pay on mainnet while the provider
 * settled on testnet — a real payment for a service that can never be
 * delivered. `fetchManifest` now takes an optional `expectedNetwork` binding
 * enforced on both the fresh-fetch and cache-hit paths, mirroring
 * `expectedPayee`.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest, invalidateManifest } from '../ModeRouter.js'
import { signManifest } from '../../manifest/sign.js'
import { RouteDockManifestError } from '../../errors.js'
import type { RouteDockManifest } from '../../types.js'

const signingKey = Keypair.random()

function createManifest(network: 'testnet' | 'mainnet'): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Network Binding Provider',
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
      price: { method: 'GET', path: '/price' },
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

describe('fetchManifest network binding (#399)', () => {
  it('rejects a testnet manifest for a mainnet-configured caller', async () => {
    const server = await startManifestServer(createManifest('testnet'))
    try {
      await assert.rejects(
        fetchManifest(server.baseUrl, undefined, undefined, undefined, 'mainnet'),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockManifestError)
          assert.match(String(err), /testnet.*mainnet|mainnet.*testnet/i)
          return true
        },
      )
    } finally {
      await server.close()
    }
  })

  it('rejects a mainnet manifest for a testnet-configured caller', async () => {
    const server = await startManifestServer(createManifest('mainnet'))
    try {
      await assert.rejects(
        fetchManifest(server.baseUrl, undefined, undefined, undefined, 'testnet'),
        RouteDockManifestError,
      )
    } finally {
      await server.close()
    }
  })

  it('accepts a manifest whose network matches the expectation', async () => {
    const server = await startManifestServer(createManifest('testnet'))
    try {
      const manifest = await fetchManifest(server.baseUrl, undefined, undefined, undefined, 'testnet')
      assert.equal(manifest.network, 'testnet')
    } finally {
      await server.close()
    }
  })

  it('keeps callers that pass no expectation permissive', async () => {
    const server = await startManifestServer(createManifest('testnet'))
    try {
      const manifest = await fetchManifest(server.baseUrl)
      assert.equal(manifest.network, 'testnet')
    } finally {
      await server.close()
    }
  })

  it('enforces the binding on cache hits too', async () => {
    const server = await startManifestServer(createManifest('testnet'))
    try {
      invalidateManifest(server.baseUrl)
      // Populate the shared cache via an unbound caller, then a bound caller
      // must still be rejected — a cached manifest must not leak across
      // differently-configured callers.
      const cached = await fetchManifest(server.baseUrl)
      assert.equal(cached.network, 'testnet')
      assert.equal(server.hits.count, 1)

      await assert.rejects(
        fetchManifest(server.baseUrl, undefined, undefined, undefined, 'mainnet'),
        RouteDockManifestError,
      )
      // The rejection came from the cache path — no second fetch.
      assert.equal(server.hits.count, 1)
    } finally {
      await server.close()
    }
  })
})
