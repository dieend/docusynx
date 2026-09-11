import {mkdtemp, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {AssetCollector} from '../src/assets.js';
import {renderedHtmlLinkSemantics, renderedHtmlToBlocks} from '../src/html.js';
import type {Block, Inline} from '../src/types.js';

describe('rendered HTML block links', () => {
  it('reads one Operations-style card independently as visible link text', () => {
    expect(
      renderedHtmlLinkSemantics({
        html: `<main><a href="/docs/operations/runbook/">
          <h2>Operations runbook</h2>
          <p>Respond to operational events.</p>
        </a></main>`,
      }),
    ).toEqual([
      {
        href: '/docs/operations/runbook/',
        text: 'Operations runbook Respond to operational events.',
      },
    ]);
  });

  it('applies one link to headings, paragraphs, lists, and admonitions', async () => {
    const blocks = await transform(`
      <main>
        <a href="/docs/target/">
          <h2>Target</h2>
          <p>Target summary.</p>
          <ul><li><p>List target.</p></li></ul>
          <blockquote><p>Quoted target.</p></blockquote>
        </a>
      </main>
    `);

    expect(linkTargets(blocks)).toEqual([
      '/docs/target/',
      '/docs/target/',
      '/docs/target/',
      '/docs/target/',
    ]);
  });

  it.each([
    ['table', '<table><tr><td>Cell</td></tr></table>'],
    ['code', '<pre><code>const value = 1</code></pre>'],
    ['mermaid', '<pre><code class="language-mermaid">graph TD</code></pre>'],
    ['thematicBreak', '<hr>'],
    ['extension', '<img src="https://images.example/diagram.png" alt="Diagram">'],
  ])('fails on a linked %s block in strict mode', async (blockType, childHtml) => {
    await expect(transform(`<main><a href="/docs/target/">${childHtml}</a></main>`)).rejects.toThrow(
      new RegExp(`route /docs/source/.*href /docs/target/.*block type ${blockType}`),
    );
  });

  it('fails on a linked local image block in strict mode', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'docusynx-html-image-'));
    await writeFile(path.join(outputDirectory, 'diagram.png'), 'image');

    await expect(
      transform('<main><a href="/docs/target/"><img src="/diagram.png" alt="Diagram"></a></main>', {
        outputDirectory,
      }),
    ).rejects.toThrow(/route \/docs\/source\/.*href \/docs\/target\/.*block type image/);
  });

  it.each([
    '<img src="https://images.example/diagram.png">',
    '<picture><source srcset="https://images.example/diagram.webp"><img src="https://images.example/diagram.png"></picture>',
  ])('fails on a linked image nested inside a paragraph', async (imageHtml) => {
    await expect(
      transform(`<main><p><a href="/docs/target/">${imageHtml}</a></p></main>`),
    ).rejects.toThrow(/route \/docs\/source\/.*href \/docs\/target\/.*block type image/);
  });

  it('fails when a meaningful inline element would produce an empty link', async () => {
    await expect(
      transform(
        '<main><p><a href="/docs/target/"><svg aria-label="Diagram"></svg></a></p></main>',
      ),
    ).rejects.toThrow(
      /route \/docs\/source\/.*href \/docs\/target\/.*unsupported inline semantics.*block type extension/,
    );
  });

  it.each(['/docs/target/', 'https://external.example/target'])(
    'fails when a direct block anchor for %s would drop an accessible SVG',
    async (href) => {
      await expect(
        transform(`<main><a href="${href}"><svg aria-label="Diagram"></svg></a></main>`),
      ).rejects.toThrow(
        new RegExp(`route /docs/source/.*href ${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*block type extension`),
      );
    },
  );

  it('fails instead of creating nested links', async () => {
    await expect(
      transform(
        '<main><a href="/docs/target/"><p><svg><a href="/docs/nested/">Nested target</a></svg></p></a></main>',
      ),
    ).rejects.toThrow(/route \/docs\/source\/.*href \/docs\/target\/.*nested link.*block type paragraph/);
  });

  it('keeps unsupported blocks without the outer link in non-strict mode', async () => {
    const blocks = await transform('<main><a href="/docs/target/"><table><tr><td>Cell</td></tr></table></a></main>', {
      strict: false,
    });

    expect(blocks).toEqual([{type: 'table', header: [[{type: 'text', value: 'Cell'}]], rows: []}]);
  });
});

async function transform(
  html: string,
  options: {outputDirectory?: string; strict?: boolean} = {},
): Promise<Block[]> {
  const outputDirectory =
    options.outputDirectory ?? (await mkdtemp(path.join(os.tmpdir(), 'docusynx-html-block-links-')));
  return (
    await renderedHtmlToBlocks({
      html,
      outDir: outputDirectory,
      baseUrl: '/',
      assets: new AssetCollector(outputDirectory),
      route: '/docs/source/',
      strict: options.strict,
    })
  ).blocks;
}

function linkTargets(blocks: Block[]): string[] {
  const targets: string[] = [];
  const visitInlines = (inlines: Inline[]): void => {
    for (const inline of inlines) {
      if (inline.type !== 'link') continue;
      targets.push(inline.target.value);
      visitInlines(inline.children);
    }
  };
  for (const block of blocks) {
    if (block.type === 'paragraph' || block.type === 'heading') visitInlines(block.inlines);
    else if (block.type === 'list') block.items.forEach((item) => targets.push(...linkTargets(item)));
    else if (block.type === 'admonition') targets.push(...linkTargets(block.blocks));
  }
  return targets;
}
