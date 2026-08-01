import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres';

export const client = postgres(connectionString);
export const db = drizzle(connectionString, { schema });
export * as schema from './schema';
