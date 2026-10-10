// Parses every ```mermaid block in the docs, so a diagram with a syntax error fails here instead of
// rendering as an error box in the browser. Run with: pnpm check:diagrams
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// mermaid expects a browser: give its parser a DOM.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { default: mermaid } = await import('mermaid');

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.mdx?$/.test(entry.name)) yield path;
  }
}

let count = 0;
let failed = 0;
for (const file of files('src/content/docs')) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
    count++;
    const line = text.slice(0, match.index).split('\n').length;
    try {
      await mermaid.parse(match[1]);
    } catch (error) {
      failed++;
      console.error(
        `${file}:${line}\n  ${String(error.message ?? error)
          .split('\n')
          .slice(0, 4)
          .join('\n  ')}\n`,
      );
    }
  }
}
console.log(`${count} diagrams parsed, ${failed} with errors`);
process.exit(failed ? 1 : 0);
