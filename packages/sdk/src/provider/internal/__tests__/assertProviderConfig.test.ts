import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { assertProviderConfig, type ProviderConfigLike } from '../assertProviderConfig.js'
import type { RouteDockManifest } from '../../../types.js'

const payeeKeypair = Keypair.random()
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const ADAPTER = 'testAdapter'

function baseManifest(): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Config Check',
    description: 'assertProviderConfig unit tests',
    modes: ['x402', 'mpp-session', 'mpp-session-ws'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: ASSET_CONTRACT,
    payee: payeeKeypair.publicKey(),
    pricing: {
      x402: { amount: '0.001', per: 'request' },
      'mpp-session': {
        rate: '0.0001',
        per: 'voucher',
        channel_factory: CHANNEL_CONTRACT,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
      'mpp-session-ws': {
        rate: '0.0002',
        per: 'voucher',
        channel_factory: CHANNEL_CONTRACT,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
    endpoints: { price: { method: 'GET', path: '/price' } },
    tags: ['test'],
  }
}

function baseOpts(): ProviderConfigLike {
  return {
    modes: ['x402', 'mpp-session', 'mpp-session-ws'],
    pricing: {
      x402: '0.001',
      'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      'mpp-session-ws': { rate: '0.0002', channelFactory: CHANNEL_CONTRACT },
    },
    asset: 'USDC',
    assetContract: ASSET_CONTRACT,
    payee: payeeKeypair.publicKey(),
    network: 'testnet',
    payeeSecretKey: payeeKeypair.secret(),
    manifest: baseManifest(),
  }
}

function throwsWith(opts: ProviderConfigLike, needle: RegExp): void {
  assert.throws(() => assertProviderConfig(opts, ADAPTER), (err: unknown) => {
    assert.ok(err instanceof Error, 'expected an Error')
    assert.match((err as { code?: string }).code ?? '', /MANIFEST/, 'error should be a manifest error')
    assert.match(err.message, needle)
    assert.match(err.message, new RegExp(`^${ADAPTER}: `), 'error must name the adapter')
    return true
  })
}

describe('assertProviderConfig', () => {
  it('accepts a consistent options/manifest pair', () => {
    assertProviderConfig(baseOpts(), ADAPTER)
  })

  it('compares amounts in base units — 0.001 options match a 0.0010 manifest', () => {
    const opts = baseOpts()
    opts.manifest.pricing.x402 = { amount: '0.0010', per: 'request' }
    opts.manifest.pricing['mpp-session'] = {
      ...opts.manifest.pricing['mpp-session']!,
      rate: '0.0001000',
    }
    assertProviderConfig(opts, ADAPTER)
  })

  it('throws on a schema-invalid manifest', () => {
    const opts = baseOpts()
    opts.manifest = { ...opts.manifest, routedock: 'banana' }
    throwsWith(opts, /Invalid manifest/)
  })

  it('throws on a semantically invalid manifest', () => {
    const opts = baseOpts()
    opts.manifest = { ...opts.manifest, latency_hints: { mars: 1 }, regions: ['earth'] }
    throwsWith(opts, /latency_hints key 'mars' is not declared in regions/)
  })

  it('throws when the adapter serves a mode manifest.modes does not list', () => {
    const opts = baseOpts()
    opts.modes = ['x402', 'mpp-charge']
    opts.pricing = { x402: '0.001', 'mpp-charge': '0.0008' }
    opts.manifest.modes = ['x402']
    delete opts.manifest.pricing['mpp-charge']
    delete opts.manifest.pricing['mpp-session']
    delete opts.manifest.pricing['mpp-session-ws']
    throwsWith(opts, /adapter serves \["mpp-charge"\] not listed in manifest\.modes/)
  })

  it('throws when manifest.modes lists a mode the adapter does not serve', () => {
    const opts = baseOpts()
    opts.modes = ['x402']
    delete opts.pricing['mpp-session']
    delete opts.pricing['mpp-session-ws']
    throwsWith(opts, /manifest\.modes lists \["mpp-session","mpp-session-ws"\] but the adapter does not serve them/)
  })

  it('throws on modes: [] next to a manifest that lists paid modes', () => {
    const opts = baseOpts()
    opts.modes = []
    opts.pricing = {}
    throwsWith(opts, /served modes differ from manifest\.modes/)
  })

  it('treats a mode listed in opts.modes without pricing as not served', () => {
    const opts = baseOpts()
    delete opts.pricing['mpp-session-ws']
    throwsWith(opts, /manifest\.modes lists \["mpp-session-ws"\] but the adapter does not serve them/)
  })

  it('throws when manifest.pricing lacks an entry for a manifest mode', () => {
    const opts = baseOpts()
    opts.modes = ['x402']
    opts.pricing = { x402: '0.001' }
    opts.manifest = {
      ...baseManifest(),
      modes: ['x402'],
      pricing: { 'mpp-charge': { amount: '0.0008', per: 'request' } },
    }
    throwsWith(opts, /manifest\.modes lists 'x402' but manifest\.pricing\.x402 is missing/)
  })

  it('throws when an x402 amount differs', () => {
    const opts = baseOpts()
    opts.pricing.x402 = '0.002'
    throwsWith(opts, /pricing\.x402 '0\.002' does not match manifest\.pricing\.x402\.amount '0\.001'/)
  })

  it('throws when an mpp-charge amount differs', () => {
    const opts = baseOpts()
    opts.modes = ['mpp-charge']
    opts.pricing = { 'mpp-charge': '0.0009' }
    opts.manifest = {
      ...baseManifest(),
      modes: ['mpp-charge'],
      pricing: { 'mpp-charge': { amount: '0.0008', per: 'request' } },
    }
    throwsWith(opts, /pricing\.mpp-charge '0\.0009' does not match manifest\.pricing\.mpp-charge\.amount '0\.0008'/)
  })

  it('throws when a session rate differs', () => {
    const opts = baseOpts()
    opts.pricing['mpp-session'] = { rate: '0.0005', channelFactory: CHANNEL_CONTRACT }
    throwsWith(opts, /pricing\.mpp-session\.rate '0\.0005' does not match manifest\.pricing\.mpp-session\.rate '0\.0001'/)
  })

  it('throws when a session channelFactory differs', () => {
    const opts = baseOpts()
    const otherFactory = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
    opts.pricing['mpp-session-ws'] = { rate: '0.0002', channelFactory: otherFactory }
    throwsWith(opts, /pricing\.mpp-session-ws\.channelFactory .* does not match manifest\.pricing\.mpp-session-ws\.channel_factory/)
  })

  it('throws when assetContract differs', () => {
    const opts = baseOpts()
    opts.assetContract = 'CCX6Q54LNCOHKS6RFXRRVGZ6YOCFK3R5MEKX4XXYSUGWCD4CZMYVLPF2'
    throwsWith(opts, /assetContract 'CCX6Q54LNCOHKS6RFXRRVGZ6YOCFK3R5MEKX4XXYSUGWCD4CZMYVLPF2' does not match manifest\.asset_contract/)
  })

  it('throws when asset differs', () => {
    const opts = baseOpts()
    opts.asset = 'yUSDC'
    throwsWith(opts, /asset 'yUSDC' does not match manifest\.asset 'USDC'/)
  })

  it('throws when network differs', () => {
    const opts = baseOpts()
    opts.network = 'mainnet'
    throwsWith(opts, /network 'mainnet' does not match manifest\.network 'testnet'/)
  })

  it('throws when payee differs', () => {
    const opts = baseOpts()
    const other = Keypair.random().publicKey()
    opts.payee = other
    throwsWith(opts, new RegExp(`payee '${other}' does not match manifest\\.payee`))
  })

  it('throws when payeeSecretKey is not a valid secret', () => {
    const opts = baseOpts()
    opts.payeeSecretKey = 'SNOTASECRET'
    throwsWith(opts, /payeeSecretKey is not a valid Stellar secret key/)
  })

  it('throws when payeeSecretKey does not belong to manifest.payee', () => {
    const opts = baseOpts()
    opts.payeeSecretKey = Keypair.random().secret()
    throwsWith(opts, /payeeSecretKey does not belong to manifest\.payee/)
  })
})
