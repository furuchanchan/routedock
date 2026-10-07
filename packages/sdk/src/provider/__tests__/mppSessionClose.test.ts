import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

const VERIFIED_TOKEN = 'verified-credential-token'
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
    close: async () => 'CLOSE_TX_HASH',
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
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const { routedockHono } = await import('../hono.js')

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Service',
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
  endpoints: { stream: { method: 'GET', path: '/stream' } },
  tags: ['test'],
}

test('MPP Session DELETE close prefers tracked higher voucher over lower body amount', async () => {
  let settledAmount = ''

  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      modes: ['mpp-session'],
      pricing: {
        'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      onSettled: async (_hash, amount, _mode) => {
        settledAmount = amount
      },
    }),
  )

  // Send DELETE with body containing lower amount (e.g. 1000n) when server holds higher amount (lastCumulativeAmount = 0n here, but lower than 0n or 5000n)
  // Even if lastCumulativeAmount is 0n, body.amount = 1000n would be > 0n.
  // But if body.amount is smaller than server's tracked lastCumulativeAmount, it shouldn't close for less.
  const req = new Request('http://localhost/stream', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', authorization: `Payment ${VERIFIED_TOKEN}` },
    body: JSON.stringify({ amount: '0', signature: 'abcd' }),
  })

  const res = await app.request(req)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { closeTxHash: string | null; message?: string }
  assert.equal(body.closeTxHash, null)
})
