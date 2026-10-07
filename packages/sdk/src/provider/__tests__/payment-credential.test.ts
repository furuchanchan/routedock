/**
 * Tests for parsePaymentCredential (#390).
 *
 * mppx 0.5.7 sends `Authorization: Payment <base64url JSON>` — a single
 * base64url token with no auth-params. The previous per-handler parsers
 * looked for a `credential=` param that is never sent, so voucher signatures
 * and payers were silently dropped. This parser accepts both forms, decodes
 * base64url safely (`atob` throws on `-`/`_`), and understands DID payers.
 *
 * Pure unit tests — no network, no signing.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { parsePaymentCredential } from '../payment-credential.js'

const payerKey = Keypair.random().publicKey()

function b64url(json: unknown): string {
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64url')
}

// ── mppx 0.5.7 wire form: bare base64url token, no auth-params ───────────────

{
  const header = `Payment ${b64url({
    source: `did:pkh:testnet:${payerKey}`,
    payload: { action: 'voucher', amount: '1000', signature: 'deadbeef42' },
  })}`
  const cred = parsePaymentCredential(header)
  assert.ok(cred)
  assert.equal(cred.signature, 'deadbeef42')
  assert.equal(cred.payer, payerKey)
  console.log('✓ bare base64url token yields signature and DID payer')
}

// ── base64url alphabet: `-`/`_` must not break decoding ─────────────────────
// 'ÿ' encodes to UTF-8 C3 BF → standard base64 produces '/', i.e. '_' in the
// base64url alphabet — a value plain atob would reject.

{
  const header = `Payment ${b64url({ payload: { signature: 'ÿþsig' } })}`
  assert.ok(header.includes('_') || !header.includes('/'), 'fixture must use url alphabet')
  const cred = parsePaymentCredential(header)
  assert.ok(cred)
  assert.equal(cred.signature, 'ÿþsig')
  console.log('✓ base64url -/_ alphabet decodes')
}

// ── Legacy credential= auth-param form still accepted ────────────────────────

{
  const legacy = Buffer.from(JSON.stringify({ payload: { signature: 'abc123' } })).toString('base64')
  const header = `Payment credential="${legacy}"`
  const cred = parsePaymentCredential(header)
  assert.ok(cred)
  assert.equal(cred.signature, 'abc123')
  console.log('✓ legacy credential= param still parses')
}

// ── sender fallbacks: sender, payload.sender, payload.from ───────────────────

{
  const cred = parsePaymentCredential(`Payment ${b64url({ sender: payerKey, payload: { signature: 'aa' } })}`)
  assert.equal(cred?.payer, payerKey)
  const cred2 = parsePaymentCredential(`Payment ${b64url({ payload: { from: payerKey } })}`)
  assert.equal(cred2?.payer, payerKey)
  console.log('✓ sender / payload.from payer fallbacks resolve')
}

// ── Voucher credentials carry no payer → payer stays null ────────────────────

{
  const cred = parsePaymentCredential(`Payment ${b64url({ payload: { signature: 'ab12' } })}`)
  assert.ok(cred)
  assert.equal(cred.signature, 'ab12')
  assert.equal(cred.payer, null)
  console.log('✓ payer-less voucher credential leaves payer null')
}

// ── Malformed / non-Payment headers yield undefined, never throw ─────────────

{
  assert.equal(parsePaymentCredential(undefined), undefined)
  assert.equal(parsePaymentCredential('Bearer xyz'), undefined)
  assert.equal(parsePaymentCredential('Payment '), undefined)
  assert.equal(parsePaymentCredential('Payment !!!not-base64!!!'), undefined)
  assert.equal(parsePaymentCredential(`Payment ${b64url('not an object')}`)?.signature, undefined)
  console.log('✓ malformed headers return undefined')
}
