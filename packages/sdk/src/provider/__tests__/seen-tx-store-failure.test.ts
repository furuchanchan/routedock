/**
 * A failed `seenTxStore.set` after on-chain settlement must not fail the
 * request (#326).
 *
 * The store write only dedupes a byte-identical retry — the funds have
 * already moved when it runs, so a throwing store (e.g. a Supabase blip in
 * `SupabaseSeenTxStore.set`) must not drop a paid request into the
 * settlement-failure path. All four adapters/mode paths record the
 * settlement through `recordSettlementSeen`, which logs the failure, reports
 * it through `onCallbackError`, and lets `onSettled` and the route run.
 *
 * Facilitators and `mppx/server` are mocked so settlement can succeed without
 * a live chain; the store is the failure under test. Runs in its own
 * process, so the other provider tests are unaffected.
 */

import { mock, describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import type { Request, Response } from 'express'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import type { RouteDockHonoOptions } from '../hono.js'
import type { RouteDockMiddlewareOptions } from '../routedockMiddleware.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const PAYER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

type SettleResponse = {
  success: boolean
  transaction: string
  errorReason?: string
}

let settleResult: SettleResponse = {
  success: true,
  transaction: 'X402_TX_HASH',
}
let settleCalls = 0

mock.module('@x402/stellar/exact/facilitator', {
  namedExports: {
    ExactStellarScheme: class {
      async verify() {
        return { isValid: true }
      }
      async settle() {
        settleCalls++
        return settleResult
      }
    },
  },
})

mock.module('@x402/core/server', {
  namedExports: {
    HTTPFacilitatorClient: class {},
    x402ResourceServer: class {
      register() {}
      async createPaymentRequiredResponse() {
        return { x402Version: 2, accepts: [] }
      }
      async settlePayment() {
        settleCalls++
        return settleResult
      }
    },
  },
})

mock.module('@x402/core/http', {
  namedExports: {
    decodePaymentSignatureHeader: () => ({
      authorization: { credentials: [{ publicKey: PAYER }] },
    }),
    encodePaymentRequiredHeader: (value: unknown) => `requirements:${JSON.stringify(value)}`,
    encodePaymentResponseHeader: (value: unknown) => `response:${JSON.stringify(value)}`,
  },
})

let chargeCalls = 0
const MPP_RECEIPT = Buffer.from(JSON.stringify({ reference: 'MPP_TX_HASH' })).toString('base64')

const actualMppxServer = await import('mppx/server')
mock.module('mppx/server', {
  namedExports: {
    ...actualMppxServer,
    Mppx: {
      create: () => ({
        'stellar/charge':
          () =>
          async (request: globalThis.Request) => {
            chargeCalls++
            if (!request.headers.get('authorization')) {
              return {
                status: 402 as const,
                challenge: new Response('Payment Required', { status: 402 }),
              }
            }
            return {
              status: 200 as const,
              withReceipt: (res: globalThis.Response) => {
                const headers = new Headers(res.headers)
                headers.set('payment-receipt', MPP_RECEIPT)
                return new Response(res.body, { status: 200, headers })
              },
            }
          },
      }),
    },
    Request: {
      fromNodeListener: (req: Request) => {
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers.set(k, v)
        }
        return new Request('http://localhost', { method: req.method, headers })
      },
    },
  },
})

const { routedockHono } = await import('../hono.js')
const { routedock } = await import('../routedockMiddleware.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Seen Store Failure Test',
  description: 'Unit test provider',
  modes: ['x402', 'mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    x402: { amount: '0.001', per: 'request' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

const BASE_OPTS = {
  asset: 'USDC',
  assetContract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  network: 'testnet' as const,
  payeeSecretKey: payeeKeypair.secret(),
  commitmentPublicKey: commitKeypair.publicKey(),
  manifest,
}

/** A store whose set() always rejects, like a Supabase upsert blip. */
function failingStore() {
  const calls: string[] = []
  return {
    calls,
    store: {
      get: () => undefined,
      set: (key: string) => {
        calls.push(key)
        throw new Error('upsert failed: connection reset')
      },
    },
  }
}

interface CallbackError {
  err: unknown
  cbName: string
}

function honoHarness(modes: ('x402' | 'mpp-charge')[], pricing: RouteDockHonoOptions['pricing'], overrides: Partial<RouteDockHonoOptions> = {}) {
  const { calls, store } = failingStore()
  const settled: string[][] = []
  const callbackErrors: CallbackError[] = []
  const logs: string[] = []
  const downstream = { called: false }

  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      ...BASE_OPTS,
      modes,
      pricing,
      seenTxStore: store,
      onSettled: async (txHash: string, amount: string, mode: string, payer: string | null) => {
        settled.push([txHash, amount, mode, String(payer)])
      },
      onCallbackError: (err: unknown, cbName: string) => {
        callbackErrors.push({ err, cbName })
      },
      logger: (level: string, message: string) => {
        logs.push(`${level}:${message}`)
      },
      ...overrides,
    }),
  )
  app.get('/price', (c) => {
    downstream.called = true
    return c.json({ price: '42' })
  })
  return { app, calls, settled, callbackErrors, logs, downstream }
}

beforeEach(() => {
  settleCalls = 0
  chargeCalls = 0
  settleResult = { success: true, transaction: 'X402_TX_HASH' }
})

describe('Hono — seenTxStore.set throws after settlement (#326)', () => {
  it('x402: still serves the resource, runs onSettled, reports seenTxStore.set', async () => {
    const h = honoHarness(['x402'], { x402: '0.001' })

    const res = await h.app.request('/price', { headers: { 'payment-signature': 'signed-payment' } })

    assert.equal(res.status, 200)
    const body = (await res.json()) as { price: string }
    assert.equal(body.price, '42')
    assert.equal(h.downstream.called, true)
    assert.equal(h.calls.length, 1, 'the failed set was still attempted')

    await new Promise((r) => setImmediate(r))
    assert.equal(h.settled.length, 1)
    assert.equal(h.settled[0]?.[0], 'X402_TX_HASH')

    const cb = h.callbackErrors.find((e) => e.cbName === 'seenTxStore.set')
    assert.ok(cb, 'onCallbackError must report the failed store write')
    assert.ok(h.logs.some((m) => m.includes('seenTxStore.set failed')))
  })

  it('mpp-charge: still serves the resource, runs onSettled, reports seenTxStore.set', async () => {
    const h = honoHarness(['mpp-charge'], { 'mpp-charge': '0.0008' })

    const res = await h.app.request('/price', { headers: { authorization: 'Payment fake-credential' } })

    assert.equal(chargeCalls, 1)
    assert.equal(res.status, 200)
    assert.equal(h.downstream.called, true)
    assert.equal(h.calls.length, 1)

    await new Promise((r) => setImmediate(r))
    assert.equal(h.settled.length, 1)
    assert.equal(h.settled[0]?.[0], 'MPP_TX_HASH')
    assert.equal(h.settled[0]?.[2], 'mpp-charge')

    assert.ok(h.callbackErrors.some((e) => e.cbName === 'seenTxStore.set'))
  })
})

interface ExpressHarness {
  url: string
  calls: string[]
  settled: string[][]
  callbackErrors: CallbackError[]
  downstream: { called: boolean }
  close: () => Promise<void>
}

async function expressHarness(
  modes: ('x402' | 'mpp-charge')[],
  pricing: Record<string, unknown>,
): Promise<ExpressHarness> {
  const { calls, store } = failingStore()
  const settled: string[][] = []
  const callbackErrors: CallbackError[] = []
  const downstream = { called: false }

  const app = express()
  app.use(
    routedock({
      ...BASE_OPTS,
      modes,
      pricing,
      seenTxStore: store,
      onSettled: async (txHash: string, amount: string, mode: string, payer: string | null) => {
        settled.push([txHash, amount, mode, String(payer)])
      },
      onCallbackError: (err: unknown, cbName: string) => {
        callbackErrors.push({ err, cbName })
      },
    } as RouteDockMiddlewareOptions),
  )
  app.get('/price', (_req: Request, res: Response) => {
    downstream.called = true
    res.json({ price: '42' })
  })

  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `http://localhost:${(server.address() as { port: number }).port}`
  return {
    url,
    calls,
    settled,
    callbackErrors,
    downstream,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('Express — seenTxStore.set throws after settlement (#326)', () => {
  it('x402: still serves the resource, runs onSettled, reports seenTxStore.set', async () => {
    const h = await expressHarness(['x402'], { x402: '0.001' })
    try {
      const res = await fetch(`${h.url}/price`, { headers: { 'payment-signature': 'signed-payment' } })

      assert.equal(res.status, 200)
      const body = (await res.json()) as { price: string }
      assert.equal(body.price, '42')
      assert.equal(h.downstream.called, true)
      assert.equal(h.calls.length, 1)

      await new Promise((r) => setImmediate(r))
      assert.equal(h.settled.length, 1)
      assert.equal(h.settled[0]?.[0], 'X402_TX_HASH')

      assert.ok(h.callbackErrors.some((e) => e.cbName === 'seenTxStore.set'))
    } finally {
      await h.close()
    }
  })

  it('mpp-charge: still serves the resource, runs onSettled, reports seenTxStore.set', async () => {
    const h = await expressHarness(['mpp-charge'], { 'mpp-charge': '0.0008' })
    try {
      const res = await fetch(`${h.url}/price`, { headers: { authorization: 'Payment fake-credential' } })

      assert.equal(chargeCalls, 1)
      assert.equal(res.status, 200)
      assert.equal(h.downstream.called, true)
      assert.equal(h.calls.length, 1)

      await new Promise((r) => setImmediate(r))
      assert.equal(h.settled.length, 1)
      assert.equal(h.settled[0]?.[0], 'MPP_TX_HASH')

      assert.ok(h.callbackErrors.some((e) => e.cbName === 'seenTxStore.set'))
    } finally {
      await h.close()
    }
  })
})
