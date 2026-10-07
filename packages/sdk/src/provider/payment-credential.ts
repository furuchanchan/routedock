import { base64UrlToUtf8 } from './encoding.js'
import { extractPayerAddress } from './payer.js'

/**
 * The fields RouteDock providers consume out of an mppx Payment credential.
 * Everything else in the wire object is opaque to us.
 */
export interface ParsedPaymentCredential {
  /** Latest voucher/commitment signature (hex) when the credential carries one. */
  signature?: string
  /** Bare Stellar public key (G.../M...) when the credential identifies a payer. */
  payer?: string | null
}

interface WireCredential {
  /** mppx charge credentials: `did:pkh:<network>:<pubkey>` */
  source?: string
  sender?: string
  payload?: {
    signature?: string
    sender?: string
    from?: string
  }
}

/**
 * Parse an `Authorization: Payment …` header into the fields providers
 * consume.
 *
 * mppx 0.5.7 serializes the whole credential as ONE base64url token
 * (`Payment <token>`) with no auth-params — earlier provider code looked for
 * a `credential=` auth-param that is never sent, so signatures and payers
 * were silently dropped. Both the bare-token form and the legacy
 * `credential=<b64>` param form are accepted here.
 *
 * The payer may arrive as a DID (`did:pkh:<network>:G...`) in `source`;
 * `extractPayerAddress` validates the bare key. Channel voucher credentials
 * carry no payer — `payer` stays null and attribution remains best-effort.
 *
 * Returns undefined when the header is absent, not a Payment credential, or
 * undecodable.
 */
export function parsePaymentCredential(
  authHeader: string | undefined | null,
): ParsedPaymentCredential | undefined {
  if (!authHeader?.startsWith('Payment ')) return undefined
  const rest = authHeader.slice('Payment '.length).trim()
  if (!rest) return undefined

  const credParam = rest
    .split(',')
    .find((p) => p.trim().startsWith('credential='))
  const b64 = credParam
    ? credParam.split('=').slice(1).join('=').replace(/^"|"$/g, '').trim()
    : rest.split(',')[0]?.trim() ?? ''
  if (!b64) return undefined

  let cred: WireCredential
  try {
    cred = JSON.parse(base64UrlToUtf8(b64)) as WireCredential
  } catch {
    return undefined
  }

  const out: ParsedPaymentCredential = {}
  if (typeof cred.payload?.signature === 'string' && cred.payload.signature.length > 0) {
    out.signature = cred.payload.signature
  }
  const didKey = typeof cred.source === 'string' ? cred.source.split(':').pop() : undefined
  const payerKey = didKey ?? cred.sender ?? cred.payload?.sender ?? cred.payload?.from
  out.payer = extractPayerAddress(payerKey)
  return out
}
