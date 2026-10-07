import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import schema from '../../schemas/routedock.schema.json' with { type: 'json' }

const ajv = new Ajv()
addFormats(ajv)
const validate = ajv.compile(schema)

const PAYEE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATOP'
const X402_PAYEE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAX402'

function baseManifest(): Record<string, unknown> {
  return {
    routedock: '1.0',
    name: 'Test Service',
    description: 'Unit test provider',
    modes: ['x402', 'mpp-charge'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: PAYEE,
    pricing: {
      x402: { amount: '0.001', per: 'request' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
    },
    endpoints: { price: { method: 'GET', path: '/price' } },
    tags: ['test'],
  }
}

describe('routedock.schema — per-mode payee', () => {
  it('accepts a manifest without per-mode payee overrides', () => {
    assert.equal(validate(baseManifest()), true, JSON.stringify(validate.errors))
  })

  it('accepts a per-mode payee override on x402 and mpp-charge', () => {
    const m = baseManifest()
    const pricing = m.pricing as Record<string, Record<string, unknown>>
    pricing.x402!.payee = X402_PAYEE
    pricing['mpp-charge']!.payee = PAYEE
    assert.equal(validate(m), true, JSON.stringify(validate.errors))
  })

  it('rejects an unknown property inside a pricing config', () => {
    const m = baseManifest()
    const pricing = m.pricing as Record<string, Record<string, unknown>>
    pricing.x402!.payeee = X402_PAYEE // typo — must not be silently accepted
    assert.equal(validate(m), false)
  })

  for (const mode of ['mpp-session', 'mpp-session-ws'] as const) {
    const sessionPricing = (): Record<string, unknown> => ({
      rate: '0.0001',
      per: 'voucher',
      channel_factory: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    })

    it(`accepts ${mode} pricing without a per-mode payee`, () => {
      const m = baseManifest()
      ;(m.modes as string[]).push(mode)
      const pricing = m.pricing as Record<string, Record<string, unknown>>
      pricing[mode] = sessionPricing()
      assert.equal(validate(m), true, JSON.stringify(validate.errors))
    })

    it(`rejects a per-mode payee on ${mode} (override not supported there)`, () => {
      const m = baseManifest()
      ;(m.modes as string[]).push(mode)
      const pricing = m.pricing as Record<string, Record<string, unknown>>
      pricing[mode] = { ...sessionPricing(), payee: PAYEE }
      assert.equal(validate(m), false)
      // The rejection must be the payee field itself — not some unrelated
      // fixture defect that would keep this test green if the schema ever
      // started allowing payee on session pricing.
      assert.ok(
        validate.errors?.some(
          (err) =>
            err.keyword === 'additionalProperties' &&
            err.instancePath === `/pricing/${mode}` &&
            (err.params as { additionalProperty?: string }).additionalProperty === 'payee',
        ),
        `expected an additionalProperties error naming payee at /pricing/${mode}, got ${JSON.stringify(validate.errors)}`,
      )
    })
  }
})
