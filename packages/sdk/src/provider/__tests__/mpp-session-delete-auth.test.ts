/**
 * Express mpp-session: DELETE (channel close) requires a verified Payment
 * credential (#394).
 *
 * Mirror of hono-delete-auth.test.ts for the Express adapter
 * (MppSessionHandler.ts): the DELETE branch previously ran before any
 * credential check, letting anyone force-close a live channel. Verification
 * now runs first, and a malformed body `amount` returns 400 instead of 500.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import type { Request, Response } from 'express'
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
    stellar: { channel: () => [] },
  },
})

mock.module('mppx/server', {
  namedExports: {
    Expires: {},
    Store: {},
    Request: {
      fromNodeListener: (req: { url?: string; method?: string; headers: Record<string, string | string[] | undefined> }) =>
        new Request('http://localhost' + (req.url ?? '/'), {
          method: req.method ?? 'GET',
          headers: typeof req.headers.authorization === 'string'
            ? { authorization: req.headers.authorization }
            : {},
        }),
    },
    Response: {},
    Transport: {},
    NodeListener: {},
    stripe: {},
    tempo: {},
    Mppx: {
      create: () => ({
        channel: (_o: { amount: string }) => async (request: globalThis.Request) => {
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

const { routedock } = await import('../routedockMiddleware.js')

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

function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  closeCalls = 0
  const app = express()
  app.use(express.json())
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
  app.get('/price', (_req: Request, res: Response) => {
    res.json({ price: '42' })
  })

  assert.ok(capturedCommit, 'commit must be captured during construction')
  return new Promise((resolve) => {
    const server = createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

describe('routedock (Express) — authenticated channel close (#394)', () => {
  it('rejects a DELETE with no credential and never calls channelClose', async () => {
    const { url, close } = await makeServer()
    try {
      const res = await fetch(url + '/price', { method: 'DELETE' })
      assert.equal(res.status, 402)
      assert.equal(closeCalls, 0)
    } finally {
      await close()
    }
  })

  it('rejects a DELETE carrying a credential for a different channel', async () => {
    const { url, close } = await makeServer()
    try {
      const res = await fetch(url + '/price', {
        method: 'DELETE',
        headers: { authorization: `Payment ${OTHER_CHANNEL_TOKEN}` },
      })
      assert.equal(res.status, 402)
      assert.equal(closeCalls, 0)
    } finally {
      await close()
    }
  })

  it('closes the channel for a DELETE carrying a valid credential', async () => {
    const { url, close } = await makeServer()
    try {
      await capturedCommit!({ payload: { amount: '1000', signature: 'c0ffee11' } })
      const res = await fetch(url + '/price', {
        method: 'DELETE',
        headers: { authorization: `Payment ${VERIFIED_TOKEN}` },
      })
      assert.equal(res.status, 200)
      assert.equal(closeCalls, 1)
    } finally {
      await close()
    }
  })

  it('returns { closeTxHash: null } for a verified DELETE with no committed record', async () => {
    const { url, close } = await makeServer()
    try {
      const res = await fetch(url + '/price', {
        method: 'DELETE',
        headers: { authorization: `Payment ${VERIFIED_TOKEN}` },
      })
      assert.equal(res.status, 200)
      const body = await res.json() as { closeTxHash: string | null }
      assert.equal(body.closeTxHash, null)
      assert.equal(closeCalls, 0)
    } finally {
      await close()
    }
  })

  it('returns 400 (not 500) for malformed amount values', async () => {
    const { url, close } = await makeServer()
    try {
      for (const amount of ['0.5', '-1', '1e3', 'abc']) {
        const res = await fetch(url + '/price', {
          method: 'DELETE',
          headers: {
            authorization: `Payment ${VERIFIED_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ amount, signature: 'c0ffee11' }),
        })
        assert.equal(res.status, 400, `amount ${amount} must be rejected as 400`)
      }
    } finally {
      await close()
    }
  })
})
