import { createApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db.js';

const server = createApp().listen(config.port, () => console.log(`wallet api listening on :${config.port}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => closePool().finally(() => process.exit(0)));
  });
}
