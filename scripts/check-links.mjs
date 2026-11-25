#!/usr/bin/env node
// Checks that relative links in the Markdown files point at files that exist, and that #anchors match a heading.
// Usage: node scripts/check-links.mjs. Exits 1 on a broken link.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && existsSync(f));

// GitHub's heading slugs: lowercase, drop punctuation except hyphens, spaces to hyphens.
const slug = (heading) =>
  heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
const anchorsOf = (file) =>
  new Set(
    [...readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1])),
  );

const problems = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [path, anchor] = target.split('#');
    const resolved = path ? normalize(join(dirname(file), path)) : file;
    if (!existsSync(resolved)) {
      problems.push(`${file}: ${target} does not exist`);
      continue;
    }
    if (anchor && resolved.endsWith('.md') && !anchorsOf(resolved).has(anchor)) {
      problems.push(`${file}: ${target} has no matching heading`);
    }
  }
}
if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`✓ links ok in ${files.length} Markdown files`);
