import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import plugin, {contentHash, type Block, type DocumentBundle, type PluginOptions} from '../src/index.js';
import * as diagrams from '../src/diagrams.js';

const flowchart = 'flowchart TD\n  Source --> Confluence';
const sequence = 'sequenceDiagram\n  Source->>Confluence: Publish SVG';
const source = [
  '# Diagram',
  '',
  '```mermaid', flowchart, '```',
  '',
  ':::note[Nested diagram]',
  '```mermaid', sequence, '```',
  '',
  '- Nested list',
  '',
  '  ```mermaid', '  flowchart TD', '    Source --> Confluence', '  ```',
  ':::',
  '',
  '```bash', 'echo preserved', '```',
].join('\n');

describe('Mermaid bundle export', () => {
  it('exports nested source and rendered Mermaid blocks as shared SVG assets with valid hashes', async () => {
    const render = vi.spyOn(diagrams, 'renderMermaidSvg');
    try {
      const fixture = await createSite({mermaidFormat: 'svg'});
      const first = await fixture.exportBundle();
      expect(first.assets).toHaveLength(2);
      expect(render).toHaveBeenCalledTimes(2);
      const authored = first.documents.find((document) => document.id === 'diagram')!;
      const rendered = first.documents.find((document) => document.id === 'route:rendered')!;
      const blocks = flatten(authored.blocks);
      expect(blocks.filter((block) => block.type === 'image')).toHaveLength(3);
      expect(blocks.some((block) => block.type === 'mermaid')).toBe(false);
      expect(blocks).toContainEqual({type: 'code', language: 'bash', value: 'echo preserved'});
      expect(authored.blocks).toContainEqual(expect.objectContaining({type: 'admonition', kind: 'note'}));
      expect(blocks).toContainEqual({type: 'paragraph', inlines: [{type: 'text', value: 'Nested diagram'}]});
      expect(blocks).toContainEqual(expect.objectContaining({type: 'list', ordered: false}));
      expect(rendered.blocks).toContainEqual(expect.objectContaining({type: 'image', assetId: blocks.find((block) => block.type === 'image')!.assetId}));
      for (const document of first.documents) {
        const {hash, ...withoutHash} = document;
        expect(hash).toBe(contentHash(withoutHash));
      }
      const {hash, ...withoutHash} = first;
      expect(hash).toBe(contentHash(withoutHash));
      for (const asset of first.assets) {
        const svg = await readFile(path.join(fixture.outDir, 'docusynx', asset.path), 'utf8');
        expect(asset.mimeType).toBe('image/svg+xml');
        expect(asset.hash).toBe(contentHashBytes(svg));
        expect(asset.id).toBe(asset.hash);
        expect(svg).toMatch(/^<svg[^>]+\bwidth="\d+"/);
        expect(svg).toMatch(/^<svg[^>]+\bheight="\d+"/);
        expect(svg).toContain('fill="#ffffff"');
      }
      const second = await fixture.exportBundle();
      expect(second).toEqual(first);
      expect(render).toHaveBeenCalledTimes(4); // Cache belongs to one build only.
    } finally {
      render.mockRestore();
    }
  }, 60_000);

  it.each([undefined, 'source'] as const)('preserves Mermaid source with mermaidFormat=%s', async (mermaidFormat) => {
    const fixture = await createSite({mermaidFormat});
    const bundle = await fixture.exportBundle();
    expect(bundle.assets).toEqual([]);
    expect(bundle.documents.flatMap((document) => flatten(document.blocks)).filter((block) => block.type === 'mermaid')).toHaveLength(4);
  });

  it('fails with the document path when Mermaid rendering fails, including in non-strict mode', async () => {
    const fixture = await createSite({mermaidFormat: 'svg'}, '```mermaid\nnot a diagram\n```');
    await expect(fixture.exportBundle()).rejects.toMatchObject({
      message: 'failed to render Mermaid diagram in docs/diagram.md',
      cause: expect.objectContaining({message: expect.stringContaining('No diagram type detected')}),
    });
  }, 30_000);

  it('rejects an unknown Mermaid format from JavaScript configuration', () => {
    expect(() => plugin({siteDir: '.', siteConfig: {}}, {mermaidFormat: 'png' as PluginOptions['mermaidFormat']}))
      .toThrow('mermaidFormat must be "source" or "svg"');
  });
});

function contentHashBytes(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function flatten(blocks: Block[]): Block[] {
  return blocks.flatMap((block) => [
    block,
    ...(block.type === 'admonition' ? flatten(block.blocks) : []),
    ...(block.type === 'list' ? block.items.flatMap(flatten) : []),
  ]);
}

async function createSite(options: PluginOptions, markdown = source) {
  const siteDir = await mkdtemp(path.join(os.tmpdir(), 'docusynx-mermaid-'));
  const outDir = path.join(siteDir, 'build');
  await mkdir(path.join(siteDir, 'docs'), {recursive: true});
  await mkdir(path.join(outDir, 'rendered'), {recursive: true});
  await writeFile(path.join(siteDir, 'docs/diagram.md'), markdown);
  await writeFile(path.join(outDir, 'rendered/index.html'), `<html><body><main><h1>Rendered diagram</h1><pre><code class="language-mermaid">${flowchart.replaceAll('>', '&gt;')}</code></pre></main></body></html>`);
  const siteConfig = {title: 'Diagrams', url: 'https://docs.example', baseUrl: '/'};
  const instance = plugin({siteDir, siteConfig}, {strict: false, ...options});
  instance.allContentLoaded({allContent: {
    'docusaurus-plugin-content-docs': {default: {loadedVersions: [{
      versionName: 'current',
      docs: [{metadata: {id: 'diagram', title: 'Diagram', permalink: '/diagram/', source: '@site/docs/diagram.md'}}],
    }]}},
  }});
  return {
    outDir,
    async exportBundle(): Promise<DocumentBundle> {
      await instance.postBuild({outDir, routesPaths: ['/diagram/', '/rendered/'], siteConfig});
      return JSON.parse(await readFile(path.join(outDir, 'docusynx/manifest.json'), 'utf8')) as DocumentBundle;
    },
  };
}
