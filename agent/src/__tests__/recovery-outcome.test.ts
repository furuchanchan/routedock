import test from 'node:test'
import assert from 'node:assert/strict'
import { recoveryOutcome } from '../recovery-outcome.js'

// #418: a partial recovery must exit 1 — checking recoveredCount first
// printed "completed successfully" and exited 0 whenever one channel
// recovered, even while others failed.

test('partial recovery (some recovered, some failed) is an error outcome', () => {
  assert.equal(recoveryOutcome({ recoveredCount: 1, failedCount: 3 }), 'errors')
})

test('all-failed recovery is an error outcome', () => {
  assert.equal(recoveryOutcome({ recoveredCount: 0, failedCount: 2 }), 'errors')
})

test('recovered with zero failures is a success outcome', () => {
  assert.equal(recoveryOutcome({ recoveredCount: 4, failedCount: 0 }), 'success')
})

test('no orphans is the none outcome', () => {
  assert.equal(recoveryOutcome({ recoveredCount: 0, failedCount: 0 }), 'none')
})
