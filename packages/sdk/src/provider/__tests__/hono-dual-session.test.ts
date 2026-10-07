/**
 * Dual session transports (mpp-session + mpp-session-ws): non-x402 requests
 * must route to the handler matching their transport (#393).
 *
 * With both modes enabled, the dispatcher used to send every non-x402 request
 * to the last-registered (ws) handler, so plain HTTP session traffic was
 * priced at the ws rate and onSettled always reported the primary mode.
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
const OTHER_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'

const VERIFIED_TOKEN = 'verified-credential-token'

let closeCalls = 0

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

/** Amounts the channel verifier was asked to require, in call order. */
const chargedAmounts: string[] = []

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
        channel: (o: { amount: string }) => async (request: globalThis.Request) => {
          chargedAmounts.push(o.amount)
          const auth = request.headers.get('authorization')
          if (auth === `Payment ${VERIFIED_TOKEN}`) {
            return { status: 200 }
          }
          return {
            status: 402,
            challenge: new Response('payment required', {
              status: 402,
              headers: { 'www-authenticate': `Payment amount="${o.amount}"` },
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
type RouteDockHonoOptions = Parameters<typeof routedockHono>[0]

function makeManifest(channelFactory = CHANNEL_CONTRACT): RouteDockManifest {
  return {
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
        rate: '0.0001',
        per: 'voucher',
        channel_factory: channelFactory,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
      'mpp-session-ws': {
        rate: '0.0002',
        per: 'voucher',
        channel_factory: channelFactory,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
    endpoints: { stream: { method: 'GET', path: '/stream' } },
    tags: ['test'],
  }
}

function makeApp(overrides: Partial<RouteDockHonoOptions> = {}) {
  closeCalls = 0
  chargedAmounts.length = 0
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
      manifest: makeManifest(),
      modes: ['mpp-session', 'mpp-session-ws'],
      pricing: {
        'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
        'mpp-session-ws': { rate: '0.0002', channelFactory: CHANNEL_CONTRACT },
      },
      ...overrides,
    } as RouteDockHonoOptions),
  )
  app.get('/stream', (c) => c.json({ ok: true }))
  return app
}

const AUTH = { authorization: `Payment ${VERIFIED_TOKEN}` }

describe('routedockHono — dual session transports (#393)', () => {
  it('routes a plain HTTP request to the mpp-session handler (session rate)', async () => {
    const app = makeApp()
    const res = await app.request('/stream', { method: 'GET', headers: AUTH })
    assert.equal(res.status, 200)
    assert.deepEqual(chargedAmounts, ['0.0001'])
  })

  it('routes a WebSocket upgrade to the mpp-session-ws handler (ws rate)', async () => {
    const app = makeApp()
    const res = await app.request('/stream', {
      method: 'GET',
      headers: { ...AUTH, upgrade: 'websocket', connection: 'upgrade' },
    })
    assert.equal(res.status, 200)
    assert.deepEqual(chargedAmounts, ['0.0002'])
  })

  it('throws at construction when the two modes advertise different channelFactory values', async () => {
    const manifest = makeManifest()
    manifest.pricing['mpp-session-ws'] = {
      rate: '0.0002',
      per: 'voucher',
      channel_factory: OTHER_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    }
    assert.throws(
      () =>
        routedockHono({
          asset: 'USDC',
          assetContract: ASSET_CONTRACT,
          payee: payeeKeypair.publicKey(),
          network: 'testnet',
          payeeSecretKey: payeeKeypair.secret(),
          commitmentPublicKey: commitKeypair.publicKey(),
          manifest,
          modes: ['mpp-session', 'mpp-session-ws'],
          pricing: {
            'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
            'mpp-session-ws': { rate: '0.0002', channelFactory: OTHER_CONTRACT },
          },
        } as RouteDockHonoOptions),
      /same channelFactory/,
    )
  })

  it('reports the serving transport to onSettled for both modes', async () => {
    const settled: string[] = []
    const app = makeApp({
      onSettled: async (_hash, _amount, mode) => {
        settled.push(mode)
      },
    })
    assert.ok(capturedCommit, 'commit must be captured during construction')

    // HTTP session traffic → close reports mpp-session
    await capturedCommit({ payload: { amount: '1000', signature: 'c0ffee11' } })
    await app.request('/stream', { method: 'GET', headers: AUTH })
    const del1 = await app.request('/stream', {
      method: 'DELETE',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '1000', signature: 'c0ffee11' }),
    })
    assert.equal(del1.status, 200)
    await new Promise((r) => setTimeout(r, 10))

    // WebSocket traffic → close reports mpp-session-ws
    await capturedCommit({ payload: { amount: '1000', signature: 'deadbeef' } })
    await app.request('/stream', {
      method: 'GET',
      headers: { ...AUTH, upgrade: 'websocket', connection: 'upgrade' },
    })
    const del2 = await app.request('/stream', {
      method: 'DELETE',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '1000', signature: 'deadbeef' }),
    })
    assert.equal(del2.status, 200)
    await new Promise((r) => setTimeout(r, 10))

    assert.deepEqual(settled, ['mpp-session', 'mpp-session-ws'])
  })
})
