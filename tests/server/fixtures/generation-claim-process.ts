import { Pool } from 'pg';

import { GenerationJobRepository } from '@/lib/server/generation-jobs/repository';

const connectionString = process.env.TEST_GENERATION_DATABASE_URL;
const [schema, workerId] = process.argv.slice(2);

async function main(): Promise<void> {
  if (!connectionString || !schema || !workerId) {
    process.exitCode = 2;
    return;
  }
  const pool = new Pool({
    connectionString,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  try {
    const repository = new GenerationJobRepository(pool);
    const claimed: string[] = [];
    for (;;) {
      const lease = await repository.claim(workerId);
      if (!lease) break;
      claimed.push(lease.jobId);
    }
    process.stdout.write(`${JSON.stringify({ claimed })}\n`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
