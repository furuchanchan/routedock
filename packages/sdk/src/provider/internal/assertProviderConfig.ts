import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest, PaymentMode } from '../../types.js'
import { RouteDockManifestError } from '../../errors.js'
import { usdcToStroops } from '../../internal/usdc.js'
import { assertManifestValid, validateManifestSchema } from '../../manifest/validate.js'

/** Fields shared by the three provider adapter option types. */
export interface ProviderConfigLike {
  modes: PaymentMode[]
  pricing: {
    x402?: string
    'mpp-charge'?: string
    'mpp-session'?: { rate: string; channelFactory: string }
    'mpp-session-ws'?: { rate: string; channelFactory: string }
  }
  asset?: string
  assetContract?: string
  payee: string
  network: string
  payeeSecretKey: string
  manifest: RouteDockManifest
}

function fail(adapter: string, msg: string): never {
  throw new RouteDockManifestError(`${adapter}: ${msg}`)
}

function usdcField(adapter: string, label: string, value: string): bigint {
  try {
    return usdcToStroops(value)
  } catch (err) {
    throw new RouteDockManifestError(
      `${adapter}: ${label} is not a valid USDC decimal: ${JSON.stringify(value)}`,
      { cause: err },
    )
  }
}

/**
 * Validate a provider adapter's options against the manifest it will sign and
 * serve. The 402 challenges are built from the options while clients only see
 * the signed manifest, so any drift between the two misleads every client:
 * a client reads pricing/payee/asset/mode facts from the manifest and is
 * charged whatever the options say.
 *
 * Throws RouteDockManifestError naming the adapter and the mismatched field
 * when the manifest is schema-invalid or semantically invalid, when the set of
 * served modes differs from manifest.modes, when any charged amount, asset,
 * network, channel factory, or payee differs from the manifest, or when
 * payeeSecretKey does not belong to manifest.payee.
 */
export function assertProviderConfig(opts: ProviderConfigLike, adapter: string): void {
  const manifest = opts.manifest
  try {
    validateManifestSchema(manifest)
    assertManifestValid(manifest)
  } catch (err) {
    if (err instanceof RouteDockManifestError) {
      fail(adapter, err.message)
    }
    throw err
  }

  // A mode is served when it is listed in opts.modes AND has a pricing entry —
  // exactly what the adapter handler registrations gate on. Manifest modes
  // are provider-wide, so serving a subset is drift too.
  const servedModes = opts.modes.filter((mode) => opts.pricing[mode] !== undefined)
  const manifestModes = new Set(manifest.modes)
  const servedSet = new Set(servedModes)
  const missingFromManifest = servedModes.filter((m) => !manifestModes.has(m))
  const missingFromServed = manifest.modes.filter((m) => !servedSet.has(m))
  if (missingFromManifest.length > 0 || missingFromServed.length > 0) {
    const parts: string[] = []
    if (missingFromServed.length > 0) {
      parts.push(`manifest.modes lists ${JSON.stringify(missingFromServed)} but the adapter does not serve them`)
    }
    if (missingFromManifest.length > 0) {
      parts.push(`adapter serves ${JSON.stringify(missingFromManifest)} not listed in manifest.modes`)
    }
    fail(adapter, `served modes differ from manifest.modes: ${parts.join('; ')}`)
  }

  for (const mode of ['x402', 'mpp-charge'] as const) {
    const optAmount = opts.pricing[mode]
    if (optAmount === undefined) continue
    const manifestEntry = manifest.pricing[mode]
    if (manifestEntry === undefined) {
      fail(adapter, `manifest.modes lists '${mode}' but manifest.pricing.${mode} is missing`)
    }
    const manifestAmount = manifestEntry.amount
    const optStroops = usdcField(adapter, `pricing.${mode}`, optAmount)
    const manifestStroops = usdcField(adapter, `manifest.pricing.${mode}.amount`, manifestAmount)
    if (optStroops !== manifestStroops) {
      fail(adapter, `pricing.${mode} '${optAmount}' does not match manifest.pricing.${mode}.amount '${manifestAmount}'`)
    }
  }

  for (const mode of ['mpp-session', 'mpp-session-ws'] as const) {
    const optCfg = opts.pricing[mode]
    if (optCfg === undefined) continue
    const manifestCfg = manifest.pricing[mode]
    if (manifestCfg === undefined) {
      fail(adapter, `manifest.modes lists '${mode}' but manifest.pricing.${mode} is missing`)
    }
    const optStroops = usdcField(adapter, `pricing.${mode}.rate`, optCfg.rate)
    const manifestStroops = usdcField(adapter, `manifest.pricing.${mode}.rate`, manifestCfg.rate)
    if (optStroops !== manifestStroops) {
      fail(adapter, `pricing.${mode}.rate '${optCfg.rate}' does not match manifest.pricing.${mode}.rate '${manifestCfg.rate}'`)
    }
    if (optCfg.channelFactory !== manifestCfg.channel_factory) {
      fail(adapter, `pricing.${mode}.channelFactory '${optCfg.channelFactory}' does not match manifest.pricing.${mode}.channel_factory '${manifestCfg.channel_factory}'`)
    }
  }

  if (opts.assetContract !== undefined && opts.assetContract !== manifest.asset_contract) {
    fail(adapter, `assetContract '${opts.assetContract}' does not match manifest.asset_contract '${manifest.asset_contract}'`)
  }
  if (opts.asset !== undefined && opts.asset !== manifest.asset) {
    fail(adapter, `asset '${opts.asset}' does not match manifest.asset '${manifest.asset}'`)
  }
  if (opts.network !== manifest.network) {
    fail(adapter, `network '${opts.network}' does not match manifest.network '${manifest.network}'`)
  }

  if (opts.payee !== manifest.payee) {
    fail(adapter, `payee '${opts.payee}' does not match manifest.payee '${manifest.payee}'`)
  }

  let derivedPayee: string
  try {
    derivedPayee = Keypair.fromSecret(opts.payeeSecretKey).publicKey()
  } catch (err) {
    throw new RouteDockManifestError(
      `${adapter}: payeeSecretKey is not a valid Stellar secret key`,
      { cause: err },
    )
  }
  if (derivedPayee !== manifest.payee) {
    fail(adapter, `payeeSecretKey does not belong to manifest.payee '${manifest.payee}'`)
  }
}
