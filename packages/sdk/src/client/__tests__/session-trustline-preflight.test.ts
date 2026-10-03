/**
 * Tests for RouteDockClient.openSession() trustline preflight (#402).
 *
 * pay() and preflight() verify via Horizon that the payer holds a trustline
 * for the manifest's payment asset before submitting anything on-chain.
 * openSession() skipped that check and went straight to channel open/funding,
 * so a missing trustline surfaced as a channel failure instead of the
 * RouteDockTrustlineError remediation message.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Horizon, Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockTrustlineError } from '../../errors.js'
import { USDC_ISSUERS } from '../../internal/usdc.js'
import { signManifest } from '../../manifest/sign.js'

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

const PAYEE_KEYPAIR = Keypair.random()

const SESSION_MANIFEST = signManifest({
  routedock: '1.0',
  name: 'Session Trustline Test Provider',
  description: 'Provider exercised by the openSession trustline preflight test',
  modes: ['mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: PAYEE_KEYPAIR.publicKey(),
  pricing: {
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { stream: { method: 'GET', path: '/stream' } },
  tags: ['test'],
}, PAYEE_KEYPAIR.secret())

test('openSession rejects with RouteDockTrustlineError before opening a channel', async (t) => {
  t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
    balances: [{ asset_type: 'native', balance: '10000.0000000' }],
  }))

  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(SESSION_MANIFEST))
    } else {
      res.writeHead(404); res.end()
    }
  })

  try {
    const payer = Keypair.random()
    const client = new RouteDockClient({
      wallet: payer,
      network: 'testnet',
      commitmentSecret: Keypair.random().secret(),
    })

    let sessionOpened = false
    ;(client as any).session.openSession = async () => { sessionOpened = true }

    await assert.rejects(
      client.openSession(`${server.url}/stream`),
      (error: unknown) => {
        assert.ok(error instanceof RouteDockTrustlineError)
        assert.equal(error.issuer, USDC_ISSUERS.testnet)
        assert.ok(error.remediation.includes(`change-trust --asset USDC:${USDC_ISSUERS.testnet}`))
        return true
      },
    )
    assert.equal(sessionOpened, false, 'channel must not be opened when the trustline is missing')
  } finally {
    await server.close()
  }
})

test('openSession proceeds to channel open once the trustline preflight passes', async (t) => {
  t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
    balances: [
      { asset_type: 'native', balance: '10000.0000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUERS.testnet, balance: '500.0000000' },
    ],
  }))

  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(SESSION_MANIFEST))
    } else {
      res.writeHead(404); res.end()
    }
  })

  try {
    const payer = Keypair.random()
    const client = new RouteDockClient({
      wallet: payer,
      network: 'testnet',
      commitmentSecret: Keypair.random().secret(),
    })

    let sessionOpened = false
    ;(client as any).session.openSession = async () => {
      sessionOpened = true
      return {} as never
    }

    await client.openSession(`${server.url}/stream`)
    assert.equal(sessionOpened, true, 'session.openSession must run after the preflight passes')
  } finally {
    await server.close()
  }
})
