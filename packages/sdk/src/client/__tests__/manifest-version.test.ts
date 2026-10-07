/**
 * fetchManifest must reject manifests whose `routedock` major version exceeds
 * the major the SDK supports (#329). A signed, schema-valid "2.0"/"9.0"
 * manifest used to be cached and routed as if it were "1.x"; the gate is a
 * RouteDockClientVersionError on both the fresh-fetch and cache-hit paths.
 */

import * as http from 'node:http'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest } from '../ModeRouter.js'
import {
  RouteDockClientVersionError,
  RouteDockError,
} from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest } from '../../types.js'

const signingKey = Keypair.random()

function createManifest(overrides: Partial<RouteDockManifest> = {}): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Version Test Provider',
    description: 'Manifest used to verify routedock major-version gating',
    modes: ['x402'],
    network: 'testnet',
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
    ...overrides,
  }
}

function signed(manifest: RouteDockManifest): RouteDockManifest & { signature: string } {
  return signManifest(manifest, signingKey.secret())
}

function startManifestServer(
  body: unknown,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

describe('fetchManifest — routedock major version gate (#329)', () => {
  it('rejects a signed, schema-valid routedock "2.0" manifest with RouteDockClientVersionError', async () => {
    const { baseUrl, close } = await startManifestServer(signed(createManifest({ routedock: '2.0' })))
    try {
      await assert.rejects(
        fetchManifest(baseUrl),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockClientVersionError)
          assert.equal((err as RouteDockError).code, 'CLIENT_VERSION_TOO_OLD')
          assert.match((err as Error).message, /2\.0/)
          assert.match((err as Error).message, /127\.0\.0\.1/)
          return true
        },
      )
    } finally {
      await close()
    }
  })

  it('rejects routedock "9.0" the same way', async () => {
    const { baseUrl, close } = await startManifestServer(signed(createManifest({ routedock: '9.0' })))
    try {
      await assert.rejects(fetchManifest(baseUrl), RouteDockClientVersionError)
    } finally {
      await close()
    }
  })

  it('accepts "1.0" and a higher minor "1.3" on fetch and on a cached second call', async () => {
    for (const version of ['1.0', '1.3']) {
      const { baseUrl, close } = await startManifestServer(signed(createManifest({ routedock: version })))
      try {
        const first = await fetchManifest(baseUrl)
        assert.equal(first.routedock, version)
        const second = await fetchManifest(baseUrl)
        assert.equal(second.routedock, version)
      } finally {
        await close()
      }
    }
  })

  it('never caches a rejected manifest: a second fetch rejects again', async () => {
    const { baseUrl, close } = await startManifestServer(signed(createManifest({ routedock: '2.0' })))
    try {
      await assert.rejects(fetchManifest(baseUrl), RouteDockClientVersionError)
      await assert.rejects(fetchManifest(baseUrl), RouteDockClientVersionError)
    } finally {
      await close()
    }
  })

  // The cache-hit branch cannot be exercised through the public API: a
  // signature-valid entry can only enter the cache by passing the fresh-fetch
  // gate first, and mutating a cached entry breaks its signature, which is
  // verified before the version check. assertManifestVersionSupported is
  // called in both branches (see fetchManifest).

})
