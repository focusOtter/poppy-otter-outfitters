import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadRootEnv } from '../src/env.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'driftbean-env-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, body: string) => writeFileSync(join(dir, name), body);

describe('loadRootEnv', () => {
  test('reads the CLI-written .env, which has quoted values', () => {
    write('.env', 'AUTH0_DOMAIN="t.example.com"\nAUTH0_AUDIENCE="http://localhost:4000"\n');
    const env: NodeJS.ProcessEnv = {};
    expect(loadRootEnv(dir, env)).toEqual(['.env']);
    expect(env).toEqual({ AUTH0_DOMAIN: 't.example.com', AUTH0_AUDIENCE: 'http://localhost:4000' });
  });

  test('.env.development.local beats .env.local beats .env, and the real environment beats all of them', () => {
    write('.env', 'A=env\nB=env\nC=env\nD=env\n');
    write('.env.local', 'A=local\nB=local\nC=local\n');
    write('.env.development.local', 'A=devlocal\nB=devlocal\n');
    const env: NodeJS.ProcessEnv = { A: 'process' };
    loadRootEnv(dir, env);
    expect(env).toEqual({ A: 'process', B: 'devlocal', C: 'local', D: 'env' });
  });

  test('skips .env.development.local in production', () => {
    write('.env.local', 'A=local\n');
    write('.env.development.local', 'A=dev\n');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    loadRootEnv(dir, env);
    expect(env.A).toBe('local');
  });

  test('is fine with no files', () => {
    expect(loadRootEnv(dir, {})).toEqual([]);
  });
});
