/**
 * Exit-code decision for the session recovery CLI (#418).
 *
 * Any failed channel recovery is an error outcome even when other channels
 * recovered — a partial run must print the error line and exit 1 so a cron
 * or operator script notices. Only a run with zero failures prints success.
 */
export function recoveryOutcome(stats: { recoveredCount: number; failedCount: number }): 'success' | 'errors' | 'none' {
  if (stats.failedCount > 0) return 'errors'
  if (stats.recoveredCount > 0) return 'success'
  return 'none'
}
