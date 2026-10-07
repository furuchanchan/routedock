/**
 * Hono mpp-session: credential signature/payer capture must happen AFTER mppx
 * verification (#390).
 *
 * Before the fix, extractPayer ran before `mppx.channel(...)`, so a forged
 * header's claimed signature was recorded — and RouteDock's copy is the
 * provider's ONLY copy of the latest signed commitment (the mppx channel
 * server stores just the cumulative amount). Signature/payer capture now runs
 * after the 402 challenge path returns, on the verified side only.
 *
 * This file mocks `@stellar/mpp/channel/server` and `mppx/server` (same
 * pattern as hono-mpp-session-ws.test.ts). The fake channel accepts only the
 * VERIFIED token — standing in for real voucher signature verification — so a
 * forged header exercises the rejected path end to end.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const sessionPayerKey = Keypair.random().publicKey()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

function b64url(json: unknown): string {
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64url')
}

const VERIFIED_TOKEN = b64url({
  source: `did:pkh:testnet:${sessionPayerKey}`,
  payload: { action: 'voucher', amount: '1000', signature: 'c0ffee11' },
})
const FORGED_TOKEN = b64url({
  payload: { action: 'voucher', amount: '1000', signature: 'deadbeef99' },
})

type WrappedStore = { put: (key: string, value: unknown) => Promise<void> }
let capturedStore: WrappedStore | null = null
let voucherCalls: Array<{ signature: string; count: number }> = []
let sessionOpenCalls: Array<{ payer: string | null }> = []

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => {
        const m = new Map<string, unknown>()
        return {
          async get(k: string) {
            return m.get(k)
          },
          async put(k: string, v: unknown) {
            m.set(k, v)
          },
          async delete(k: string) {
            m.delete(k)
          },
          update(k: string, fn: (v: unknown) => unknown) {
            m.set(k, fn(m.get(k)))
          },
        }
      },
    },
    close: async () => 'CLOSE_TX_HASH',
    stellar: (opts: { store: unknown }) => {
      capturedStore = opts.store as WrappedStore
      return []
    },
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
        // Fake verification: only VERIFIED_TOKEN counts as a valid credential.
        channel: (_opts: { amount: string }) => async (request: Request) => {
          const auth = request.headers.get('authorization')
          if (auth === `Payment ${VERIFIED_TOKEN}`) {
            return { status: 200 }
          }
          return {
            status: 402,
            challenge: new Response('Payment Required', {
              status: 402,
              headers: {
                'www-authenticate':
                  'Payment id="test", realm="test", method="stellar", intent="channel", request="e30"',
              },
            }),
          }
        },
      }),
    },
  },
})

const { routedockHono } = await import('../hono.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Session Service',
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
  endpoints: { stream: { method: 'GET', path: '/stream/orderbook' } },
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
      onSessionOpen: async (_factory, payer) => {
        sessionOpenCalls.push({ payer })
      },
      onVoucher: async (_factory, count, _amount, signature) => {
        voucherCalls.push({ signature, count })
      },
    }),
  )
  app.get('/stream/orderbook', (c) => c.json({ ok: true }))
  return app
}

describe('routedockHono — credential capture after verification (#390)', () => {
  it('does NOT record a signature from a credential mppx rejected', async () => {
    voucherCalls = []
    sessionOpenCalls = []
    const app = makeApp()
    const res = await app.request('/stream/orderbook', {
      method: 'GET',
      headers: { authorization: `Payment ${FORGED_TOKEN}` },
    })
    assert.equal(res.status, 402)

    // A later real voucher (fed via the captured wrapped store) must report
    // the still-empty signature — the forged one was never recorded.
    assert.ok(capturedStore)
    await capturedStore!.put(`stellar:channel:cumulative:${CHANNEL_CONTRACT}`, { amount: '1000' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(voucherCalls.length, 1)
    assert.equal(voucherCalls[0]!.signature, '')
  })

  it('records the signature and DID payer only after verification', async () => {
    voucherCalls = []
    sessionOpenCalls = []
    const app = makeApp()
    const res = await app.request('/stream/orderbook', {
      method: 'GET',
      headers: { authorization: `Payment ${VERIFIED_TOKEN}` },
    })
    assert.equal(res.status, 200)

    assert.ok(capturedStore)
    await capturedStore!.put(`stellar:channel:cumulative:${CHANNEL_CONTRACT}`, { amount: '2000' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(voucherCalls.length, 1)
    assert.equal(voucherCalls[0]!.signature, 'c0ffee11')
    assert.equal(sessionOpenCalls.length, 1)
    assert.equal(sessionOpenCalls[0]!.payer, sessionPayerKey)
  })
})
