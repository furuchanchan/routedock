import { Validator, type Schema } from '@cfworker/json-schema'
import type { RouteDockManifest } from '../types.js'
import { RouteDockManifestError } from '../errors.js'
import schema from '../schemas/routedock.schema.json' assert { type: 'json' }

const validator = new Validator(schema as unknown as Schema, '7')

/**
 * Validate a manifest document against routedock.schema.json.
 * Throws RouteDockManifestError with the joined validator errors.
 */
export function validateManifestSchema(manifest: unknown, context?: string): void {
  const result = validator.validate(manifest)
  if (!result.valid) {
    const msgs = result.errors.map(err => err.error).join('; ')
    throw new RouteDockManifestError(
      `Invalid manifest${context ? ` at ${context}` : ''}: ${msgs}`,
    )
  }
}

/**
 * Validate semantic constraints for manifest fields beyond JSON schema syntax.
 * Enforces:
 * - All keys in `latency_hints` must be a subset of declared `regions`.
 * - If `assets` is defined, it must be a non-empty array whose first entry
 *   (`assets[0]`) matches the root-level `asset` and `asset_contract`.
 */
export function assertManifestValid(manifest: RouteDockManifest, baseUrl?: string): void {
  const context = baseUrl ? ` at ${baseUrl}` : ''
  if (manifest.latency_hints !== undefined) {
    if (!Array.isArray(manifest.regions) || manifest.regions.length === 0) {
      throw new RouteDockManifestError(
        `Invalid manifest${context}: latency_hints defined without declaring regions`,
      )
    }
    const regionSet = new Set(manifest.regions)
    for (const region of Object.keys(manifest.latency_hints)) {
      if (!regionSet.has(region)) {
        throw new RouteDockManifestError(
          `Invalid manifest${context}: latency_hints key '${region}' is not declared in regions (${manifest.regions.join(', ')})`,
        )
      }
    }
  }

  if (manifest.assets !== undefined) {
    if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
      throw new RouteDockManifestError(
        `Invalid manifest${context}: assets must be a non-empty array when defined`,
      )
    }
    for (let i = 0; i < manifest.assets.length; i++) {
      const a = manifest.assets[i]
      if (!a || typeof a.asset !== 'string' || typeof a.asset_contract !== 'string') {
        throw new RouteDockManifestError(
          `Invalid manifest${context}: assets[${i}] must define asset and asset_contract strings`,
        )
      }
    }
    const first = manifest.assets[0]!
    if (first.asset !== manifest.asset || first.asset_contract !== manifest.asset_contract) {
      throw new RouteDockManifestError(
        `Invalid manifest${context}: assets[0] (${first.asset}:${first.asset_contract}) must match root asset fields (${manifest.asset}:${manifest.asset_contract})`,
      )
    }
  }
}
