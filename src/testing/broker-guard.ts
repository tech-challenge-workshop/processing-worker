export type BrokerSuiteMode = 'run' | 'skip' | 'fail';

/**
 * Decides how `test/broker.e2e-spec.ts` treats a missing broker (ROB-08).
 *
 * With `RABBITMQ_TEST_URL` set the suite runs. Without it, a developer
 * machine skips the suite, but CI fails it, so the suite can never go green
 * by skipping. `CI=false` counts as unset: GitHub Actions only ever sets
 * `true`, and `false` is how a developer says "not CI".
 *
 * Test-only, and pure: it lives under `src/` only because the unit Jest
 * config looks nowhere else.
 */
export function brokerSuiteMode(
  env: Record<string, string | undefined>,
): BrokerSuiteMode {
  if (env.RABBITMQ_TEST_URL) {
    return 'run';
  }
  const inCi = Boolean(env.CI) && env.CI !== 'false';
  return inCi ? 'fail' : 'skip';
}
