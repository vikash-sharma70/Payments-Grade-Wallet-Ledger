import cron from 'node-cron';
import { config } from './config.js';
import { closePool } from './db.js';
import { createLlm } from './llm/index.js';
import { purgeOldIdempotencyKeys, runReconciliation } from './services/reconciliation.js';
import { explainRecentFlags } from './services/riskExplain.js';

/** The nightly job: check the books, explain the day's fraud flags, purge old idempotency keys. */
export async function runNightly(trigger: 'cron' | 'manual' = 'cron') {
  const llm = createLlm();
  const recon = await runReconciliation(trigger);
  console.log(`[nightly] reconciliation: ${recon.status}`, recon.problem_count ?? '', recon.error ?? '');
  if (recon.status === 'problems_found') console.error('[nightly] PROBLEMS FOUND, see reconciliation run', recon.run_id);
  const explained = await explainRecentFlags(llm);
  console.log('[nightly] risk flags explained', explained);
  const purged = await purgeOldIdempotencyKeys(config.idempotencyTtlHours);
  console.log(`[nightly] purged ${purged} idempotency keys`);
}

console.log(`worker started, nightly job schedule: "${config.reconCron}"`);
cron.schedule(config.reconCron, () => {
  runNightly('cron').catch((e) => console.error('[nightly] failed', e));
});

if (process.env.RUN_ON_START === '1') runNightly('manual').catch((e) => console.error(e));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => closePool().finally(() => process.exit(0)));
}
