/**
 * Hono dual session modes: transport-aware routing and per-transport settle
 * reporting (#393).
 *
 * With both `mpp-session` and `mpp-session-ws` enabled, the dispatcher used to
 * send every non-x402 request to the LAST registered handler — always the ws
 * one — so plain HTTP session requests were priced and challenged at the ws
 * rate, and onSettled always reported 'mpp-session'. Requests now route by
 * transport (upgrade → ws, otherwise → session), and the serving transport is
 * recorded so the close reports it.
 *
 * This file mocks `@stellar/mpp/channel/server` and `mppx/server` (same
 * pattern as hono-mpp-session-ws.test.ts). The fake channel treats
 * VERIFIED_TOKEN as the only valid credential and embeds the charged amount
 * in the 402 challenge body so tests can see which pricing entry drove it.
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
const SESSION_RATE = '0.0001'
const WS_RATE = '0.0002'

function b64url(json: unknown): string {
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64url')
}

const VERIFIED_TOKEN = b64url({
  payload: { action: 'voucher', amount: '1000', signature: 'c0ffee11' },
})

type WrappedStore = { put: (key: string, value: unknown) => Promise<void> }
let capturedStore: WrappedStore | null = null
let settleCalls: Array<{ txHash: string; amount: string; mode: string }> = []

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
        // Fake verification: only VERIFIED_TOKEN is a valid credential; the
        // challenge body echoes the amount the middleware charged so tests
        // can read which pricing entry drove the challenge.
        channel: (o: { amount: string }) => async (request: Request) => {
          const auth = request.headers.get('authorization')
          if (auth === `Payment ${VERIFIED_TOKEN}`) {
            return { status: 200 }
          }
          return {
            status: 402,
            challenge: new Response(`charged:${o.amount}`, {
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
  name: 'Dual Session Service',
  description: 'Unit test provider',
  modes: ['mpp-session', 'mpp-session-ws'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-session': {
      rate: SESSION_RATE,
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
    'mpp-session-ws': {
      rate: WS_RATE,
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { stream: { method: 'GET', path: '/stream/orderbook' } },
  tags: ['test'],
}

function makeOpts() {
  return {
    asset: 'USDC',
    assetContract: ASSET_CONTRACT,
    payee: payeeKeypair.publicKey(),
    network: 'testnet' as const,
    payeeSecretKey: payeeKeypair.secret(),
    commitmentPublicKey: commitKeypair.publicKey(),
    manifest,
    modes: ['mpp-session', 'mpp-session-ws'] as Array<'mpp-session' | 'mpp-session-ws'>,
    pricing: {
      'mpp-session': { rate: SESSION_RATE, channelFactory: CHANNEL_CONTRACT },
      'mpp-session-ws': { rate: WS_RATE, channelFactory: CHANNEL_CONTRACT },
    },
    onSettled: async (txHash: string, amount: string, mode: string) => {
      settleCalls.push({ txHash, amount, mode })
    },
  }
}

function makeApp() {
  const app = new Hono()
  app.use('*', routedockHono(makeOpts()))
  app.get('/stream/orderbook', (c) => c.json({ ok: true }))
  return app
}

const WS_HEADERS = { upgrade: 'websocket', connection: 'Upgrade' }

describe('routedockHono — dual session modes (#393)', () => {
  it('challenges plain HTTP requests at the mpp-session rate', async () => {
    const app = makeApp()
    const res = await app.request('/stream/orderbook', { method: 'GET' })
    assert.equal(res.status, 402)
    assert.equal(await res.text(), `charged:${SESSION_RATE}`)
  })

  it('challenges WebSocket upgrades at the mpp-session-ws rate', async () => {
    const app = makeApp()
    const res = await app.request('/stream/orderbook', { method: 'GET', headers: WS_HEADERS })
    assert.equal(res.status, 402)
    assert.equal(await res.text(), `charged:${WS_RATE}`)
  })

  it('throws at construction when the two transports use different channelFactories', () => {
    const opts = makeOpts()
    opts.pricing['mpp-session-ws'] = { rate: WS_RATE, channelFactory: 'COTHERFACTORYOTHERFACTORYOTHERFACTORY0000000000' }
    assert.throws(() => routedockHono(opts as never), /same channelFactory/)
  })

  it('reports the serving transport to onSettled on DELETE close', async () => {
    settleCalls = []
    const app = makeApp()

    // HTTP session voucher → close must report mpp-session.
    const r1 = await app.request('/stream/orderbook', {
      method: 'GET',
      headers: { authorization: `Payment ${VERIFIED_TOKEN}` },
    })
    assert.equal(r1.status, 200)
    assert.ok(capturedStore)
    await capturedStore!.put(`stellar:channel:cumulative:${CHANNEL_CONTRACT}`, { amount: '1000' })
    // The client signs the close amount: body signature is accepted here
    // because it matches the tracked cumulative (provider capture is #390).
    const d1 = await app.request('/stream/orderbook', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '1000', signature: 'c0ffee11' }),
    })
    assert.equal(d1.status, 200)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(settleCalls.at(-1)?.mode, 'mpp-session')

    // A WS session voucher → close must report mpp-session-ws.
    const r2 = await app.request('/stream/orderbook', {
      method: 'GET',
      headers: { ...WS_HEADERS, authorization: `Payment ${VERIFIED_TOKEN}` },
    })
    assert.equal(r2.status, 200)
    await capturedStore!.put(`stellar:channel:cumulative:${CHANNEL_CONTRACT}`, { amount: '2000' })
    const d2 = await app.request('/stream/orderbook', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '2000', signature: 'c0ffee22' }),
    })
    assert.equal(d2.status, 200)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(settleCalls.at(-1)?.mode, 'mpp-session-ws')
  })
})
