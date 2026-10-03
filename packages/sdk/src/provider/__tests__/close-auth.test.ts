/**
 * DELETE close must authenticate before any session state is touched (#394).
 * The credential is the same proof of ownership the channel contract checks
 * on-chain: a commitment signature over `prepare_commitment(amount)` that
 * verifies under the channel's commitment key.
 *
 * prepare_commitment is mocked to fixed bytes so the gate can be exercised
 * with real signatures; `close` on '@stellar/mpp/channel/server' is a spy
 * proving the close broadcast is never reached for unauthenticated
 * requests. The captured `commit` callback (same pattern as
 * hono-verified-voucher.test.ts) drives "a credential mppx verified" so
 * session state can be shown intact after a rejected DELETE.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const otherChannelKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

let closeCalls: Array<{ amount: bigint }> = []

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => {
        const m = new Map<string, unknown>()
        return {
          async get(k: string) { return m.get(k) },
          async put(k: string, v: unknown) { m.set(k, v) },
          async delete(k: string) { m.delete(k) },
          update(k: string, fn: (v: unknown) => unknown) { m.set(k, fn(m.get(k))) },
        }
      },
    },
    close: async (opts: { amount: bigint }) => {
      closeCalls.push({ amount: opts.amount })
      return 'mock-close-tx-hash'
    },
    // hono calls `stellar(...)` directly; Express calls `stellar.channel(...)`.
    stellar: Object.assign(() => [], { channel: () => [] }),
  },
})

const actualCompat = await import('../mppCompatibility.js')
type Commit = (credential: { payload?: unknown; source?: string }) => void | Promise<void>
let lastCommit: Commit | null = null
mock.module('../mppCompatibility.js', {
  namedExports: {
    channelAuthorizer: actualCompat.channelAuthorizer,
    withTypedChannelErrors: actualCompat.withTypedChannelErrors,
    formatMppError: actualCompat.formatMppError,
    onVerifiedCredential: (method: unknown, commit: Commit) => {
      lastCommit = commit
      return method
    },
  },
})

const COMMITMENT_BYTES = Buffer.from('routedock-close-auth-test-bytes')
mock.module('../commitment-sim.js', {
  namedExports: { simulatePrepareCommitment: async () => COMMITMENT_BYTES },
})
const closeCredential = (amount: string, signer: Keypair = commitKeypair) => ({
  amount,
  signature: signer.sign(COMMITMENT_BYTES).toString('hex'),
})

const { routedockHono } = await import('../hono.js')
const { routedock } = await import('../routedockMiddleware.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Close Auth Test Service',
  description: 'Unit test provider',
  modes: ['mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

function buildHonoApp(): { app: Hono; commit: Commit } {
  closeCalls = []
  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
    }),
  )
  const commit = lastCommit!
  return { app, commit }
}

const deleteReq = (body?: unknown) =>
  ({
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as const

describe('mpp-session DELETE close authentication (#394)', () => {
  it('rejects a DELETE with no credential and never calls channelClose', async () => {
    const { app } = buildHonoApp()
    const res = await app.request('/price', { method: 'DELETE' })
    assert.equal(res.status, 401)
    assert.equal(closeCalls.length, 0)
  })

  it('leaves session state unchanged after an unauthenticated DELETE — a later close still settles the tracked record', async () => {
    const { app, commit } = buildHonoApp()
    const rejected = await app.request('/price', { method: 'DELETE' })
    assert.equal(rejected.status, 401)
    assert.equal(closeCalls.length, 0)

    // Voucher verification on the real path still works after the rejected
    // DELETE, and a credentialed close settles at the tracked amount.
    await commit({ payload: { amount: '5000', signature: 'ab'.repeat(64) } })
    const res = await app.request('/price', deleteReq(closeCredential('5000')))
    assert.equal(res.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.equal(closeCalls[0]?.amount, 5000n)
  })

  it('closes with a valid credential for the open channel, as before', async () => {
    const { app, commit } = buildHonoApp()
    await commit({ payload: { amount: '5000', signature: 'cd'.repeat(64) } })
    const res = await app.request('/price', deleteReq(closeCredential('5000')))
    assert.equal(res.status, 200)
    const json = (await res.json()) as { closeTxHash: string }
    assert.equal(json.closeTxHash, 'mock-close-tx-hash')
    assert.equal(closeCalls.length, 1)
  })

  it('rejects a credential signed by a different channel key without closing', async () => {
    const { app, commit } = buildHonoApp()
    await commit({ payload: { amount: '5000', signature: 'ab'.repeat(64) } })
    const res = await app.request(
      '/price',
      deleteReq(closeCredential('5000', otherChannelKeypair)),
    )
    assert.equal(res.status, 401)
    assert.equal(closeCalls.length, 0)
  })

  it('rejects a non-integer amount with 400, not a BigInt 500', async () => {
    const { app } = buildHonoApp()
    for (const amount of ['0.5', '-1', '1e3', 'abc']) {
      const res = await app.request(
        '/price',
        deleteReq({ amount, signature: 'aa'.repeat(64) }),
      )
      assert.equal(res.status, 400, `amount ${amount} must be a 400`)
      const json = (await res.json()) as { error: string }
      assert.ok(json.error, 'expected a JSON error body')
    }
    assert.equal(closeCalls.length, 0)
  })

  it('rejects a non-string amount with 400', async () => {
    const { app } = buildHonoApp()
    const res = await app.request(
      '/price',
      deleteReq({ amount: 123, signature: 'aa'.repeat(64) }),
    )
    assert.equal(res.status, 400)
    assert.equal(closeCalls.length, 0)
  })

  it('rejects a well-formed body whose signature does not verify, without closing', async () => {
    const { app } = buildHonoApp()
    const res = await app.request(
      '/price',
      deleteReq({ amount: '5000', signature: 'ff'.repeat(64) }),
    )
    assert.equal(res.status, 401)
    assert.equal(closeCalls.length, 0)
  })
})

describe('Express adapter — same DELETE ordering (#394)', () => {
  async function makeExpressServer() {
    closeCalls = []
    const app = express()
    app.use(
      routedock({
        asset: 'USDC',
        assetContract: ASSET_CONTRACT,
        payee: payeeKeypair.publicKey(),
        network: 'testnet',
        payeeSecretKey: payeeKeypair.secret(),
        commitmentPublicKey: commitKeypair.publicKey(),
        manifest,
        modes: ['mpp-session'],
        pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      } as Parameters<typeof routedock>[0]),
    )
    app.get('/price', (_req, res) => {
      res.json({ price: '42' })
    })
    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((res) => server.close(() => res())),
    }
  }

  it('rejects an unauthenticated DELETE and accepts a credentialed one', async () => {
    const { url, close } = await makeExpressServer()
    try {
      const rejected = await fetch(`${url}/price`, { method: 'DELETE' })
      assert.equal(rejected.status, 401)
      assert.equal(closeCalls.length, 0)

      const bad = await fetch(`${url}/price`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '0.5', signature: 'aa'.repeat(64) }),
      })
      assert.equal(bad.status, 400)

      // The credential is read from the raw stream — the test app registers
      // no express.json(), matching providers without a body parser.
      const ok = await fetch(`${url}/price`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(closeCredential('0')),
      })
      assert.equal(ok.status, 200)
      const json = (await ok.json()) as { closeTxHash: string | null }
      assert.equal(json.closeTxHash, null)
    } finally {
      await close()
    }
  })
})
