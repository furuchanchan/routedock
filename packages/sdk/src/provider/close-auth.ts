import { Keypair } from '@stellar/stellar-sdk'

export type CloseAuthResult =
  | { ok: true; bodyAmount: bigint; bodySignature: string }
  | { ok: false; status: 400 | 401 | 503; error: string }

/**
 * Authenticate a DELETE close before any session state is touched (#394):
 * the request must carry a commitment signature over
 * `prepare_commitment(amount)` that verifies under the channel's commitment
 * key — the same proof of channel ownership the contract checks on-chain,
 * so the HTTP close path is no weaker than calling `close` directly.
 * A malformed `amount` is a 400; a missing or unverifiable credential is a
 * 401 and the close is never attempted. An RPC failure while verifying
 * returns 503 — the gate fails closed, never open.
 */
export async function authenticateCloseRequest(params: {
  body: unknown
  channelFactory: string
  commitmentPublicKey: string | undefined
  network: 'testnet' | 'mainnet'
  sourceAccount: string
}): Promise<CloseAuthResult> {
  const body =
    params.body && typeof params.body === 'object'
      ? (params.body as { amount?: unknown; signature?: unknown })
      : undefined

  if (body?.amount !== undefined) {
    if (typeof body.amount !== 'string' || !/^\d+$/.test(body.amount)) {
      return { ok: false, status: 400, error: 'invalid amount' }
    }
  }

  if (
    body?.amount === undefined ||
    typeof body.signature !== 'string' ||
    !/^[0-9a-fA-F]+$/.test(body.signature)
  ) {
    return { ok: false, status: 401, error: 'close credential required' }
  }

  if (!params.commitmentPublicKey) {
    return {
      ok: false,
      status: 503,
      error: 'close credential verification unavailable',
    }
  }

  try {
    // Lazy so a mocked './commitment-sim.js' is picked up even when the
    // adapter module itself was imported before the mock was registered.
    const { simulatePrepareCommitment } = await import('./commitment-sim.js')
    const commitmentBytes = await simulatePrepareCommitment({
      channelFactory: params.channelFactory,
      network: params.network,
      sourceAccount: params.sourceAccount,
      amount: BigInt(body.amount),
    })
    const valid = Keypair.fromPublicKey(params.commitmentPublicKey).verify(
      Buffer.from(commitmentBytes),
      Buffer.from(body.signature, 'hex'),
    )
    if (!valid) {
      return { ok: false, status: 401, error: 'invalid close credential' }
    }
  } catch {
    return {
      ok: false,
      status: 503,
      error: 'close credential verification unavailable',
    }
  }

  return { ok: true, bodyAmount: BigInt(body.amount), bodySignature: body.signature }
}
