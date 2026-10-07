/**
 * Hono mpp-session: DELETE (channel close) requires a verified Payment
 * credential (#394).
 *
 * Previously the DELETE branch ran before any credential check, so a bare
 * DELETE could force-close any live channel — the payee paid each close fee
 * and the agent's session died mid-stream. DELETE now goes through the same
 * mppx channel verification as data requests; only a caller holding a valid
 * credential for this channel may close it. The body `amount` is also
 * validated before BigInt so malformed values return 400, not 500.
 *
 * This file mocks `@stellar/mpp/channel/server`, `mppx/server`, and
 * `../mppCompatibility.js` (the same pattern as hono-orphan-close.test.ts) —
 * VERIFIED_TOKEN is the only accepted credential, commit is captured so the
 * test can seed a verified voucher record, and channelClose calls are
 * counted.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

function b64url(json: unknown): string {
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64url')
}

const VERIFIED_TOKEN = b64url({ payload: { amount: '1000', signature: 'c0ffee11' } })
const OTHER_CHANNEL_TOKEN = b64url({ payload: { amount: '1000', signature: 'deadbeef' } })

let closeCalls: number = 0

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
    close: async () => {
      closeCalls += 1
      return 'CLOSE_TX_HASH'
    },
    stellar: () => [],
  },
})

mock.module('mppx/server', {
  namedExports: {
    Expires: {},
    Store: {},
    Request: {},
    Response: {},
    Transport: {},
    NodeListener: {},
    stripe: {},
    tempo: {},
    Mppx: {
      create: () => ({
        // Only VERIFIED_TOKEN verifies — a credential issued for a different
        // channel (or a forged token) fails exactly like the real mppx check.
        channel: (_o: { amount: string }) => async (request: Request) => {
          const auth = request.headers.get('authorization')
          if (auth === `Payment ${VERIFIED_TOKEN}`) {
            return { status: 200 }
          }
          return {
            status: 402,
            challenge: new Response('payment required', {
              status: 402,
              headers: { 'www-authenticate': 'Payment id="test", realm="test", method="stellar", intent="channel", request="e30"' },
            }),
          }
        },
      }),
    },
  },
})

const actualCompat = await import('../mppCompatibility.js')
type Commit = (credential: { payload?: unknown; source?: string }) => void | Promise<void>
let capturedCommit: Commit | null = null
mock.module('../mppCompatibility.js', {
  namedExports: {
    channelAuthorizer: actualCompat.channelAuthorizer,
    withTypedChannelErrors: actualCompat.withTypedChannelErrors,
    formatMppError: actualCompat.formatMppError,
    onVerifiedCredential: (method: unknown, commit: Commit) => {
      capturedCommit = commit
      return method
    },
  },
})

const { routedockHono } = await import('../hono.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Delete Auth Service',
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

function makeApp() {
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
  app.get('/price', (c) => c.json({ price: '42' }))
  return app
}

async function seedVoucher(amount: string, signature: string): Promise<void> {
  assert.ok(capturedCommit, 'commit must be captured during construction')
  await capturedCommit!({ payload: { amount, signature } })
}

describe('routedockHono — authenticated channel close (#394)', () => {
  it('rejects a DELETE with no credential and never calls channelClose', async () => {
    closeCalls = 0
    const app = makeApp()
    const res = await app.request('/price', { method: 'DELETE' })
    assert.equal(res.status, 402)
    assert.equal(closeCalls, 0)
  })

  it('leaves session state untouched so a verified voucher still succeeds', async () => {
    const app = makeApp()
    await app.request('/price', { method: 'DELETE' })
    const ok = await app.request('/price', {
      method: 'GET',
      headers: { authorization: `Payment ${VERIFIED_TOKEN}` },
    })
    assert.equal(ok.status, 200)
  })

  it('rejects a DELETE carrying a credential for a different channel', async () => {
    closeCalls = 0
    const app = makeApp()
    await seedVoucher('1000', 'c0ffee11')
    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { authorization: `Payment ${OTHER_CHANNEL_TOKEN}` },
    })
    assert.equal(res.status, 402)
    assert.equal(closeCalls, 0)
  })

  it('closes the channel for a DELETE carrying a valid credential', async () => {
    closeCalls = 0
    const app = makeApp()
    await seedVoucher('1000', 'c0ffee11')
    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { authorization: `Payment ${VERIFIED_TOKEN}` },
    })
    assert.equal(res.status, 200)
    assert.equal(closeCalls, 1)
  })

  it('returns { closeTxHash: null } for a verified DELETE with no committed record', async () => {
    closeCalls = 0
    const app = makeApp()
    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { authorization: `Payment ${VERIFIED_TOKEN}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json() as { closeTxHash: string | null }
    assert.equal(body.closeTxHash, null)
    assert.equal(closeCalls, 0)
  })

  it('returns 400 (not 500) for malformed amount values', async () => {
    const app = makeApp()
    for (const amount of ['0.5', '-1', '1e3', 'abc']) {
      const res = await app.request('/price', {
        method: 'DELETE',
        headers: {
          authorization: `Payment ${VERIFIED_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ amount, signature: 'c0ffee11' }),
      })
      assert.equal(res.status, 400, `amount ${amount} must be rejected as 400`)
      const body = await res.json() as { error?: string }
      assert.match(body.error ?? '', /invalid amount/)
    }
  })
})
