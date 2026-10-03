import { Contract, TransactionBuilder, BASE_FEE, nativeToScVal, Networks, rpc } from '@stellar/stellar-sdk'

/**
 * Simulate `prepare_commitment(amount)` on the channel-factory contract and
 * return the commitment bytes a close/voucher signature must cover. Kept in
 * its own module so the DELETE-close gate's callers can be tested with
 * fixed bytes instead of stubbing the RPC client.
 */
export async function simulatePrepareCommitment(params: {
  channelFactory: string
  network: 'testnet' | 'mainnet'
  /** Any funded account — only used as the simulation's transaction source. */
  sourceAccount: string
  amount: bigint
}): Promise<Uint8Array> {
  const rpcUrl = params.network === 'testnet'
    ? 'https://soroban-testnet.stellar.org'
    : 'https://soroban.stellar.org'
  const server = new rpc.Server(rpcUrl)
  const contract = new Contract(params.channelFactory)
  const account = await server.getAccount(params.sourceAccount)
  const simTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase:
      params.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
  })
    .addOperation(
      contract.call(
        'prepare_commitment',
        nativeToScVal(params.amount, { type: 'i128' }),
      ),
    )
    .setTimeout(30)
    .build()
  const simResult = await server.simulateTransaction(simTx)
  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`prepare_commitment simulation failed: ${simResult.error}`)
  }
  const bytes = (
    simResult as { result?: { retval?: { bytes: () => Uint8Array } } }
  ).result?.retval?.bytes()
  if (!bytes || bytes.length === 0) {
    throw new Error('prepare_commitment returned no bytes')
  }
  return bytes
}
