/**
 * Manifest validation gaps that used to surface as raw TypeError/Error/
 * RangeError now surface as typed RouteDock* errors (#327):
 *  - modes entries must have matching pricing entries
 *  - deprecated_modes must be a subset of modes
 *  - pricing amounts/rates/min_deposit must parse as USDC decimals
 *  - payee / asset_contract / channel_factory carry StrKey patterns
 *  - verifyManifestSignature wraps a malformed payee in RouteDockSignatureError
 */

import * as http from 'node:http'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest, assertManifestValid } from '../ModeRouter.js'
import { RouteDockClient } from '../RouteDockClient.js'
import {
  RouteDockError,
  RouteDockManifestError,
  RouteDockSignatureError,
} from '../../errors.js'
import { signManifest, verifyManifestSignature } from '../../manifest/sign.js'
import schema from '../../schemas/routedock.schema.json' with { type: 'json' }
import type { RouteDockManifest } from '../../types.js'

const ajv = new Ajv()
addFormats(ajv)
const validate = ajv.compile(schema)

const signingKey = Keypair.random()
const VALID_PAYEE = signingKey.publicKey()
const USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_FACTORY = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

function createManifest(overrides: Partial<RouteDockManifest> = {}): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Validation Test Provider',
    description: 'Manifest used to verify typed validation errors',
    modes: ['x402', 'mpp-charge'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: USDC_CONTRACT,
    payee: VALID_PAYEE,
    pricing: {
      x402: { amount: '0.001', per: 'request', facilitator: 'https://facilitator.example' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
    },
    endpoints: {
      price: { method: 'GET', path: '/price' },
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

// ── assertManifestValid: semantic consistency ────────────────────────────────

describe('assertManifestValid — modes/pricing/deprecated consistency (#327)', () => {
  it('rejects a mode with no matching pricing entry, naming the mode', () => {
    const manifest = createManifest({
      modes: ['x402'],
      pricing: { 'mpp-charge': { amount: '0.0008', per: 'request' } } as RouteDockManifest['pricing'],
    })
    assert.throws(
      () => assertManifestValid(manifest, 'http://provider.test'),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockManifestError)
        assert.match((err as Error).message, /x402/)
        assert.match((err as Error).message, /pricing\.x402/)
        return true
      },
    )
  })

  it('rejects deprecated_modes entries missing from modes', () => {
    const manifest = createManifest({ deprecated_modes: ['mpp-session'] })
    assert.throws(
      () => assertManifestValid(manifest),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockManifestError)
        assert.match((err as Error).message, /mpp-session/)
        return true
      },
    )
  })

  const badAmounts = ['abc', '0.00000001', '-1', '']
  const fullPricing = (bad: { field: string; value: string }) => {
    const pricing: Record<string, Record<string, unknown>> = {
      x402: { amount: '0.001', per: 'request' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
      'mpp-session': {
        rate: '0.0001', per: 'voucher', channel_factory: CHANNEL_FACTORY,
        min_deposit: '0.10', refund_waiting_period_ledgers: 17280,
      },
      'mpp-session-ws': {
        rate: '0.0001', per: 'voucher', channel_factory: CHANNEL_FACTORY,
        min_deposit: '0.10', refund_waiting_period_ledgers: 17280,
      },
    }
    const [mode, field] = bad.field.split('.')
    pricing[mode!]![field!] = bad.value
    return pricing
  }
  const numericCases = ['x402.amount', 'mpp-session.rate', 'mpp-session-ws.min_deposit']

  for (const label of numericCases) {
    for (const bad of badAmounts) {
      it(`rejects pricing.${label} = ${JSON.stringify(bad)} with RouteDockManifestError`, () => {
        const manifest = createManifest({
          modes: ['x402', 'mpp-charge', 'mpp-session', 'mpp-session-ws'],
          pricing: fullPricing({ field: label, value: bad }) as RouteDockManifest['pricing'],
        })
        assert.throws(
          () => assertManifestValid(manifest),
          (err: unknown) => {
            assert.ok(err instanceof RouteDockManifestError)
            assert.ok(err instanceof RouteDockError)
            assert.match((err as Error).message, /not a valid USDC decimal/)
            assert.ok((err as { cause?: unknown }).cause instanceof RangeError)
            return true
          },
        )
      })
    }
  }

  it('accepts manifests shaped like the reference providers', () => {
    // provider-a shape: x402 + mpp-charge
    assert.doesNotThrow(() => assertManifestValid(createManifest()))
    // provider-b shape: session modes with rate/min_deposit pricing
    const sessionManifest = createManifest({
      modes: ['mpp-session', 'mpp-session-ws'],
      pricing: {
        'mpp-session': {
          rate: '0.0001', per: 'voucher', channel_factory: CHANNEL_FACTORY,
          min_deposit: '0.10', refund_waiting_period_ledgers: 17280,
        },
        'mpp-session-ws': {
          rate: '0.0002', per: 'voucher', channel_factory: CHANNEL_FACTORY,
          min_deposit: '0.10', refund_waiting_period_ledgers: 17280,
        },
      } as RouteDockManifest['pricing'],
    })
    assert.doesNotThrow(() => assertManifestValid(sessionManifest))
  })
})

// ── schema: StrKey + decimal patterns ─────────────────────────────────────────

describe('routedock.schema — StrKey and decimal patterns (#327)', () => {
  it('accepts the reference valid manifest', () => {
    assert.equal(validate(createManifest()), true, JSON.stringify(validate.errors))
  })

  const rejectCases: Array<[string, (m: Record<string, unknown>) => void]> = [
    ['top-level payee not a G... StrKey', (m) => { m.payee = 'G...' }],
    ['top-level payee too short', (m) => { m.payee = 'GABC' }],
    ['pricing.x402.payee invalid', (m) => {
      (m.pricing as Record<string, Record<string, unknown>>).x402!.payee = 'notakey'
    }],
    ['asset_contract not a C... StrKey', (m) => { m.asset_contract = 'CTEST' }],
    ['channel_factory not a C... StrKey', (m) => {
      ;(m.modes as string[]).push('mpp-session')
      ;(m.pricing as Record<string, unknown>)['mpp-session'] = {
        rate: '0.0001', per: 'voucher', channel_factory: 'CNOTVALID',
        min_deposit: '0.10', refund_waiting_period_ledgers: 17280,
      }
    }],
    ['amount with 8 decimals', (m) => {
      (m.pricing as Record<string, Record<string, unknown>>).x402!.amount = '0.00000001'
    }],
    ['amount non-numeric', (m) => {
      (m.pricing as Record<string, Record<string, unknown>>)['mpp-charge']!.amount = 'abc'
    }],
    ['rate negative', (m) => {
      ;(m.modes as string[]).push('mpp-session')
      ;(m.pricing as Record<string, unknown>)['mpp-session'] = {
        rate: '-1', per: 'voucher', channel_factory: CHANNEL_FACTORY,
        min_deposit: '0.10', refund_waiting_period_ledgers: 17280,
      }
    }],
  ]

  for (const [label, mutate] of rejectCases) {
    it(`rejects ${label}`, () => {
      const m = createManifest() as unknown as Record<string, unknown>
      mutate(m)
      assert.equal(validate(m), false, `${label} passed schema`)
    })
  }
})

// ── end to end: fetchManifest / estimateCost typed errors ─────────────────────

describe('fetchManifest — malformed manifests produce typed errors (#327)', () => {
  it('rejects a signed manifest whose modes lack pricing entries', async () => {
    const manifest = signed(createManifest({
      modes: ['x402'],
      pricing: { 'mpp-charge': { amount: '0.0008', per: 'request' } } as RouteDockManifest['pricing'],
    }))
    const { baseUrl, close } = await startManifestServer(manifest)
    try {
      await assert.rejects(
        fetchManifest(baseUrl),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockManifestError)
          assert.match((err as Error).message, /x402/)
          return true
        },
      )
    } finally {
      await close()
    }
  })

  it('estimateCost on the same manifest rejects with a RouteDockError, not a TypeError', async () => {
    const manifest = signed(createManifest({
      modes: ['x402'],
      pricing: { 'mpp-charge': { amount: '0.0008', per: 'request' } } as RouteDockManifest['pricing'],
    }))
    const { baseUrl, close } = await startManifestServer(manifest)
    try {
      const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
      await assert.rejects(
        client.estimateCost(`${baseUrl}/price`),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockError, `expected RouteDockError, got ${err}`)
          return true
        },
      )
    } finally {
      await close()
    }
  })

  it('preflight() throws RouteDockManifestError for the missing-pricing manifest', async () => {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    const manifest = createManifest({
      modes: ['x402'],
      pricing: { 'mpp-charge': { amount: '0.0008', per: 'request' } } as RouteDockManifest['pricing'],
    })
    await assert.rejects(client.preflight(manifest), RouteDockManifestError)
  })

  it('rejects a placeholder payee with a typed error (schema path)', async () => {
    const manifest = signed(createManifest({ payee: 'G...' as string }))
    const { baseUrl, close } = await startManifestServer(manifest)
    try {
      await assert.rejects(
        fetchManifest(baseUrl),
        (err: unknown) => err instanceof RouteDockError,
      )
    } finally {
      await close()
    }
  })

  it('rejects a pattern-shaped but invalid payee with a typed error (signature path)', async () => {
    // Matches ^G[A-Z2-7]{55}$ but is not a valid StrKey checksum, so it
    // passes the schema and fails inside verifyManifestSignature.
    const fakePayee = `G${'A'.repeat(55)}`
    const manifest = signed(createManifest({ payee: fakePayee }))
    const { baseUrl, close } = await startManifestServer(manifest)
    try {
      await assert.rejects(
        fetchManifest(baseUrl),
        (err: unknown) => err instanceof RouteDockError,
      )
    } finally {
      await close()
    }
  })
})

// ── verifyManifestSignature direct ───────────────────────────────────────────

describe('verifyManifestSignature — malformed payee (#327)', () => {
  it('wraps Keypair.fromPublicKey failures in RouteDockSignatureError', () => {
    const manifest = { ...signed(createManifest()), payee: 'G...' }
    assert.throws(
      () => verifyManifestSignature(manifest),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockSignatureError)
        assert.match((err as Error).message, /not a valid Stellar public key/)
        return true
      },
    )
  })
})
