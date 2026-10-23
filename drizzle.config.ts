import { defineConfig } from 'drizzle-kit';
import { assertStagingIsolation, isStagingEnvironment } from './src/lib/envGuard';

// Fail-closed guard: em staging, bloqueia execuções Drizzle se o isolamento estiver violado
if (isStagingEnvironment()) {
  assertStagingIsolation();
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres',
  },
});
