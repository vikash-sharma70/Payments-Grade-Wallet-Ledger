export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5433/wallet',
  port: Number(process.env.PORT ?? 3000),
  adminToken: process.env.ADMIN_TOKEN ?? 'dev-admin-token',
  poolMax: Number(process.env.PG_POOL_MAX ?? 30),
  llmProvider: process.env.LLM_PROVIDER ?? 'mock',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  llmModel: process.env.LLM_MODEL ?? 'claude-haiku-4-5-20251001',
  reconCron: process.env.RECON_CRON ?? '0 2 * * *',
  // Flat withdrawal fee in paise (charged as a separate `fee` transfer to FEE_REVENUE).
  withdrawalFeePaise: Number(process.env.WITHDRAWAL_FEE_PAISE ?? 200),
  idempotencyTtlHours: 24,
} as const;
