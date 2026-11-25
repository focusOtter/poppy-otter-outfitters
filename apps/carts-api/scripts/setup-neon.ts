import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { OUTFITTERS } from '../src/outfitters.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const sql = neon(process.env.DATABASE_URL);
const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
await sql.transaction(schema.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => sql.query(statement)));
await sql.transaction(OUTFITTERS.map((product) => sql`
  INSERT INTO products (id, details) VALUES (${product.id}, ${JSON.stringify(product)}::jsonb)
  ON CONFLICT (id) DO UPDATE SET details = EXCLUDED.details
`));
console.log(`Neon schema ready; ${OUTFITTERS.length} products seeded.`);
