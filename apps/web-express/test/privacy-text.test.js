// The privacy page exists twice: apps/web/app/privacy/page.tsx (Next.js) and views.privacy() here. This test reads the
// text of both, paragraph by paragraph, and fails when they differ in anything but the differences listed below.
//
//   npm --prefix apps/web-express test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { privacy } from '../src/views.js';

const NEXT_PAGE = new URL('../../web/app/privacy/page.tsx', import.meta.url);

// Elements that start a new block of text. Everything else (a, strong, Link) is inline.
const BLOCK = new Set(['article', 'div', 'section', 'header', 'h1', 'h2', 'p', 'ul', 'li', 'Panel', 'PageHeader']);
const ENTITIES = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>' };
const decode = (text) =>
  text.replace(/&(#\d+|\w+);/g, (match, name) => (name[0] === '#' ? String.fromCharCode(Number(name.slice(1))) : ENTITIES[name] ?? match));

/** Splits markup into blocks of text and the link targets, given how each runtime treats the whitespace in text. */
function readMarkup(markup, whitespace) {
  const blocks = [];
  const hrefs = [];
  let text = '';
  for (const [, tag, attributes, between] of markup.matchAll(/<\/?([A-Za-z][\w.]*)([^>]*)>|([^<]+)/g)) {
    if (between !== undefined) {
      text += whitespace(between);
      continue;
    }
    const href = /\bhref="([^"]*)"/.exec(attributes)?.[1];
    if (href) hrefs.push(href);
    if (BLOCK.has(tag)) {
      blocks.push(text);
      text = '';
      // The Next.js page passes headings as props: <Panel title="…">, <PageHeader title="…">.
      const title = /\btitle="([^"]*)"/.exec(attributes)?.[1];
      if (title) blocks.push(title);
    }
  }
  blocks.push(text);
  return { blocks: blocks.map((block) => decode(block).replace(/\s+/g, ' ').trim()).filter(Boolean), hrefs };
}

// JSX: a run of text that spans lines loses each line's indentation and its blank lines, and its lines are joined
// with one space. `{" "}` is a space.
const jsxWhitespace = (text) =>
  text
    .split('{" "}')
    .map((part) =>
      part.includes('\n')
        ? part
            .split('\n')
            .map((line, i, lines) => (i === 0 ? line.trimEnd() : i === lines.length - 1 ? line.trimStart() : line.trim()))
            .filter(Boolean)
            .join(' ')
        : part,
    )
    .join(' ');

function nextText() {
  const source = readFileSync(NEXT_PAGE, 'utf8');
  const jsx = source.slice(source.indexOf('<article'), source.indexOf('</article>') + '</article>'.length);
  assert.doesNotMatch(jsx, /\{(?!" "\})/, 'page.tsx uses a JSX expression this test does not read; extend the test');
  return readMarkup(jsx, jsxWhitespace);
}

test('the Next.js and Express privacy pages say the same thing', () => {
  const next = nextText();
  const express = readMarkup(String(privacy()), (text) => text);

  // Intended differences. Express has no Agents page, so it keeps only the paragraph's last sentences.
  const agents = next.blocks.findIndex((block) => block.startsWith('On the Agents page'));
  assert.notEqual(agents, -1, 'the Next.js page no longer mentions the Agents page; update this test');
  next.blocks[agents] = next.blocks[agents].slice(next.blocks[agents].indexOf('Agent records'));
  // Express may run on any host, so its Hosting line names none; the Next.js storefront is deployed to Vercel.
  const hosting = (blocks) => blocks.findIndex((block) => block.startsWith('Hosting.'));
  assert.match(next.blocks[hosting(next.blocks)], /Vercel/);
  assert.doesNotMatch(express.blocks[hosting(express.blocks)], /Vercel/);
  express.blocks[hosting(express.blocks)] = next.blocks[hosting(next.blocks)];
  const nextHrefs = next.hrefs.filter((href) => href !== '/agents' && href !== 'https://vercel.com/legal/privacy-policy');

  assert.deepEqual(express.blocks, next.blocks);
  assert.deepEqual(express.hrefs, nextHrefs);
});
