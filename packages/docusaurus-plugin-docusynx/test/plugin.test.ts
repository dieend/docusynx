import {cp, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import plugin, {type ComponentHandlerRegistration, type DocumentBundle} from '../src/index.js';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = path.join(packageDirectory, 'test/fixtures/example');

describe('Docusaurus exporter', () => {
  it('exports documentation-site-shaped docs, generated routes, components, hierarchy, and assets', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'docusynx-exporter-'));
    const siteDir = path.join(temporaryDirectory, 'site');
    await cp(fixtureDirectory, siteDir, {recursive: true});
    const outDir = path.join(siteDir, 'build');
    const instance = plugin(
      {siteDir, siteConfig: {title: 'Example Docs', url: 'https://docs.example', baseUrl: '/product/'}},
      {
        siteName: 'example-docs',
        sourceBaseUrl: 'https://git.example/example-docs',
        sourceCommit: 'abc123',
        sourcePathPrefix: 'src/product/docs',
        renderedRoutePatterns: ['/reference/api/**'],
        sourcePathMappings: [
          {routePattern: '/reference/api/**', sourcePath: 'api/openapi.yaml'},
          {routePattern: '/reference/starlark/**', sourcePath: 'workflow/reference.star'},
        ],
        strict: true,
        componentHandlers: fixtureHandlers(),
      },
    );
    instance.allContentLoaded({allContent: docusaurusContent()});
    await instance.postBuild({
      outDir,
      routesPaths: ['/', '/docs/introduction/', '/docs/category/operations/', '/docs/operations/runbook/', '/reference/api/widgets/', '/reference/starlark/'],
      siteConfig: {title: 'Example Docs', url: 'https://docs.example', baseUrl: '/product/'},
    });

    const manifestPath = path.join(outDir, 'docusynx/manifest.json');
    const firstBytes = await readFile(manifestPath, 'utf8');
    const bundle = JSON.parse(firstBytes) as DocumentBundle;
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.documents.map((document) => document.id)).toEqual([
      'introduction',
      'page:index',
      'category:docssidebar-operations',
      'operations/runbook',
      'reference/api/widgets',
      'reference/starlark',
      'reference/starlark/globals/constants',
      'reference/starlark/globals/overview',
    ].sort());
    expect(bundle.documents.find((document) => document.id === 'reference/starlark')?.parentId).toBe('introduction');
    expect(bundle.documents.some((document) => document.id === 'category:docssidebar-globals')).toBe(false);
    expect(bundle.documents.find((document) => document.id === 'reference/starlark/globals/overview')).toMatchObject({
      parentId: 'introduction',
      route: '/reference/starlark/globals/',
    });
    expect(bundle.documents.find((document) => document.id === 'reference/starlark/globals/constants')?.parentId).toBe(
      'reference/starlark/globals/overview',
    );
    const operationsCategory = bundle.documents.find((document) => document.id === 'category:docssidebar-operations');
    expect(operationsCategory).toMatchObject({
      route: '/docs/category/operations/',
      source: {path: 'src/product/docs/.docusaurus/routes/docs/category/operations/index.html'},
    });
    expect(operationsCategory?.source.url).toBeUndefined();
    expect(operationsCategory?.blocks).toContainEqual({
      type: 'paragraph',
      inlines: [{type: 'text', value: 'Operational documentation generated from the sidebar category.'}],
    });
    expect(operationsCategory?.blocks).toEqual(
      expect.arrayContaining([
        {
          type: 'heading',
          level: 2,
          inlines: [
            {
              type: 'link',
              target: {kind: 'document', value: 'operations/runbook'},
              children: [{type: 'text', value: 'Operations runbook'}],
            },
          ],
        },
        {
          type: 'paragraph',
          inlines: [
            {
              type: 'link',
              target: {kind: 'document', value: 'operations/runbook'},
              children: [{type: 'text', value: 'Respond to operational events.'}],
            },
          ],
        },
      ]),
    );
    expect(bundle.documents.find((document) => document.id === 'operations/runbook')?.parentId).toBe(
      'category:docssidebar-operations',
    );
    expect(bundle.documents.some((document) => document.id === 'route:docs/category/operations')).toBe(false);
    expect(bundle.documents.find((document) => document.id === 'reference/api/widgets')?.blocks).toContainEqual({
      type: 'heading', level: 2, inlines: [{type: 'text', value: 'GET /widgets'}],
    });
    expect(bundle.documents.find((document) => document.id === 'page:index')?.blocks).toContainEqual({
      type: 'paragraph', inlines: [{type: 'text', value: 'Operate accelerated computing infrastructure.'}],
    });
    expect(bundle.documents.find((document) => document.id === 'page:index')?.blocks).toContainEqual({
      type: 'heading',
      level: 2,
      inlines: [{
        type: 'link',
        target: {kind: 'document', value: 'introduction'},
        children: [{type: 'text', value: 'Documentation'}],
      }],
    });
    expect(bundle.documents.find((document) => document.id === 'introduction')?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({type: 'mermaid'}),
        expect.objectContaining({type: 'admonition', kind: 'note'}),
        expect.objectContaining({type: 'table'}),
        expect.objectContaining({type: 'code', language: 'bash', title: 'Run docusynx'}),
        expect.objectContaining({type: 'code', title: 'docker-compose.yml'}),
        expect.objectContaining({type: 'image'}),
      ]),
    );
    expect(bundle.documents.find((document) => document.id === 'introduction')?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'paragraph',
          inlines: expect.arrayContaining([
            expect.objectContaining({
              type: 'link',
              target: {kind: 'url', value: 'https://docs.example/product/downloads/example.yaml'},
            }),
          ]),
        }),
      ]),
    );
    expect(bundle.documents.find((document) => document.id === 'introduction')?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'paragraph',
          inlines: expect.arrayContaining([
            expect.objectContaining({
              type: 'link',
              target: {kind: 'document', value: 'reference/starlark'},
            }),
          ]),
        }),
      ]),
    );
    expect(bundle.documents.find((document) => document.id === 'introduction')?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'paragraph',
          inlines: expect.arrayContaining([
            expect.objectContaining({
              type: 'link',
              target: {kind: 'document', value: 'reference/starlark'},
              children: [{type: 'text', value: 'workflow section'}],
            }),
          ]),
        }),
        expect.objectContaining({
          type: 'paragraph',
          inlines: expect.arrayContaining([
            expect.objectContaining({
              type: 'link',
              target: {kind: 'document', value: 'reference/starlark'},
              children: [{type: 'text', value: 'filtered reference'}],
            }),
          ]),
        }),
        expect.objectContaining({
          type: 'paragraph',
          inlines: expect.arrayContaining([
            expect.objectContaining({
              type: 'link',
              target: {kind: 'url', value: '#generated-content'},
            }),
          ]),
        }),
        expect.objectContaining({
          type: 'paragraph',
          inlines: expect.arrayContaining([
            expect.objectContaining({
              type: 'link',
              target: {
                kind: 'url',
                value: 'https://docs.example/product/docs/introduction/artifacts/example.zip',
              },
            }),
          ]),
        }),
        expect.objectContaining({
          type: 'paragraph',
          inlines: expect.arrayContaining([
            expect.objectContaining({
              type: 'link',
              target: {kind: 'url', value: 'https://cdn.example/file.zip'},
            }),
          ]),
        }),
      ]),
    );
    expect(bundle.assets).toHaveLength(1);
    expect(bundle.documents.every((document) => document.hash.startsWith('sha256:'))).toBe(true);
    expect(bundle.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bundle.documents.find((document) => document.id === 'introduction')?.source).toEqual({
      path: 'src/product/docs/docs/introduction.mdx',
      url: 'https://git.example/example-docs/-/blob/abc123/src/product/docs/docs/introduction.mdx',
      commit: 'abc123',
    });
    expect(bundle.documents.find((document) => document.id === 'reference/api/widgets')?.source).toEqual({
      path: 'api/openapi.yaml',
      url: 'https://git.example/example-docs/-/blob/abc123/api/openapi.yaml',
      commit: 'abc123',
    });
    expect(bundle.documents.find((document) => document.id === 'reference/starlark')?.source.path).toBe(
      'workflow/reference.star',
    );

    await instance.postBuild({
      outDir,
      routesPaths: ['/', '/docs/introduction/', '/docs/category/operations/', '/docs/operations/runbook/', '/reference/api/widgets/', '/reference/starlark/'],
      siteConfig: {title: 'Example Docs', url: 'https://docs.example', baseUrl: '/product/'},
    });
    expect(await readFile(manifestPath, 'utf8')).toBe(firstBytes);
  });

  it('fails on an unknown imported MDX component', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'docusynx-unknown-'));
    const siteDir = path.join(temporaryDirectory, 'site');
    await cp(fixtureDirectory, siteDir, {recursive: true});
    const instance = plugin({siteDir, siteConfig: {title: 'Test'}}, {strict: true});
    instance.allContentLoaded({allContent: docusaurusContent()});
    await expect(instance.postBuild({outDir: path.join(siteDir, 'build'), siteConfig: {title: 'Test'}}))
      .rejects.toThrow(/unknown MDX component ComposeBlock.*ComposeBlock/);
  });

  it('fails when source path mappings overlap', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'docusynx-mappings-'));
    const siteDir = path.join(temporaryDirectory, 'site');
    await cp(fixtureDirectory, siteDir, {recursive: true});
    const instance = plugin(
      {siteDir, siteConfig: {title: 'Test'}},
      {
        renderedRoutePatterns: ['/reference/api/**'],
        sourcePathMappings: [
          {routePattern: '/reference/**', sourcePath: 'reference.md'},
          {routePattern: '/reference/api/**', sourcePath: 'openapi.yaml'},
        ],
        componentHandlers: fixtureHandlers(),
      },
    );
    instance.allContentLoaded({allContent: docusaurusContent()});
    await expect(instance.postBuild({outDir: path.join(siteDir, 'build'), siteConfig: {title: 'Test'}}))
      .rejects.toThrow(/matches multiple sourcePathMappings/);
  });

  it('fails when one block anchor is only partly represented in the bundle document', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'docusynx-link-parity-'));
    const siteDir = path.join(temporaryDirectory, 'site');
    await cp(fixtureDirectory, siteDir, {recursive: true});
    const outDir = path.join(siteDir, 'build');
    await writeFile(
      path.join(siteDir, 'docs/introduction.mdx'),
      '# Source\n\n[Operations runbook](/docs/operations/runbook/)\n',
    );
    await writeFile(
      path.join(outDir, 'docs/introduction/index.html'),
      '<!doctype html><html><body><main><article><div class="theme-doc-markdown"><h1>Source</h1><a href="/docs/operations/runbook/"><h2>Operations runbook</h2><p>Respond to operational events.</p></a></div></article></main></body></html>',
    );
    const instance = plugin(
      {siteDir, siteConfig: {title: 'Example Docs', url: 'https://docs.example', baseUrl: '/product/'}},
      {strict: true, componentHandlers: fixtureHandlers()},
    );
    instance.allContentLoaded({allContent: linkParityContent()});

    await expect(
      instance.postBuild({
        outDir,
        routesPaths: ['/', '/docs/introduction/', '/docs/operations/runbook/'],
        siteConfig: {title: 'Example Docs', url: 'https://docs.example', baseUrl: '/product/'},
      }),
    ).rejects.toThrow(
      /rendered internal link parity failed for route \/docs\/introduction\/.*Operationsrunbook.*Respondtooperationalevents/,
    );
  });

  it('skips rendered link parity in non-strict mode', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'docusynx-link-parity-nonstrict-'));
    const siteDir = path.join(temporaryDirectory, 'site');
    await cp(fixtureDirectory, siteDir, {recursive: true});
    const outDir = path.join(siteDir, 'build');
    await writeFile(
      path.join(siteDir, 'docs/introduction.mdx'),
      '# Source\n\n[Operations runbook](/docs/operations/runbook/)\n',
    );
    await writeFile(
      path.join(outDir, 'docs/introduction/index.html'),
      '<!doctype html><html><body><main><article><div class="theme-doc-markdown"><h1>Source</h1><a href="/docs/operations/runbook/"><h2>Operations runbook</h2><p>Respond to operational events.</p></a></div></article></main></body></html>',
    );
    const instance = plugin(
      {siteDir, siteConfig: {title: 'Example Docs', url: 'https://docs.example', baseUrl: '/product/'}},
      {strict: false, componentHandlers: fixtureHandlers()},
    );
    instance.allContentLoaded({allContent: linkParityContent()});

    await expect(
      instance.postBuild({
        outDir,
        routesPaths: ['/', '/docs/introduction/', '/docs/operations/runbook/'],
        siteConfig: {title: 'Example Docs', url: 'https://docs.example', baseUrl: '/product/'},
      }),
    ).resolves.toBeUndefined();
  });
});

function fixtureHandlers(): ComponentHandlerRegistration[] {
  return [
    {
      importSource: '@site/src/components/ComposeBlock',
      exportName: 'default',
      handler: path.join(packageDirectory, 'test/handlers/compose-block.cjs'),
    },
    {
      importSource: '@site/src/components/DataFlow',
      exportName: 'ArchitectureDiagram',
      handler: path.join(packageDirectory, 'test/handlers/architecture-diagram.ts'),
    },
    {
      importSource: '@site/src/components/StarlarkReference',
      exportName: 'default',
      handler: path.join(packageDirectory, 'test/handlers/starlark-reference.ts'),
    },
  ];
}

function linkParityContent(): unknown {
  return {
    'docusaurus-plugin-content-docs': {
      default: {
        loadedVersions: [
          {
            versionName: 'current',
            docs: [
              {
                metadata: {
                  id: 'introduction',
                  title: 'Example documentation',
                  permalink: '/docs/introduction/',
                  source: '@site/docs/introduction.mdx',
                },
              },
              {
                metadata: {
                  id: 'operations/runbook',
                  title: 'Operations runbook',
                  permalink: '/docs/operations/runbook/',
                  source: '@site/docs/operations/runbook.md',
                },
              },
            ],
          },
        ],
      },
    },
    'docusaurus-plugin-content-pages': {
      default: {
        loadedPages: [{metadata: {title: 'Example Docs', permalink: '/', source: '@site/src/pages/index.tsx'}}],
      },
    },
  };
}

function docusaurusContent(): unknown {
  return {
    'docusaurus-plugin-content-docs': {
      default: {
        loadedVersions: [{
          versionName: 'current',
          docs: [
            {metadata: {id: 'introduction', title: 'Example documentation', permalink: '/docs/introduction/', source: '@site/docs/introduction.mdx'}},
            {metadata: {id: 'operations/runbook', title: 'Operations runbook', permalink: '/docs/operations/runbook/', source: '@site/docs/operations/runbook.md'}},
            {metadata: {id: 'reference/starlark', title: 'Starlark reference', permalink: '/reference/starlark/', source: '@site/generated/starlark/reference.mdx'}},
            {metadata: {id: 'reference/starlark/globals/overview', title: 'Globals', permalink: '/reference/starlark/globals/', source: '@site/generated/starlark/reference.mdx'}},
            {metadata: {id: 'reference/starlark/globals/constants', title: 'Constants', permalink: '/reference/starlark/globals/constants/', source: '@site/generated/starlark/reference.mdx'}},
            {metadata: {id: 'reference/api/widgets', title: 'Widgets API', permalink: '/reference/api/widgets/', source: '@site/generated/openapi/widgets.mdx'}},
          ],
          sidebars: {
            docsSidebar: [
              {
                type: 'category',
                label: 'Documentation',
                link: {type: 'doc', id: 'introduction'},
                items: [
                  {type: 'doc', id: 'reference/starlark'},
                  {type: 'doc', id: 'reference/api/widgets'},
                  {
                    type: 'category',
                    label: 'Globals',
                    items: [
                      {type: 'doc', id: 'reference/starlark/globals/overview'},
                      {type: 'doc', id: 'reference/starlark/globals/constants'},
                    ],
                  },
                ],
              },
              {
                type: 'category',
                label: 'Operations',
                link: {type: 'generated-index', slug: '/category/operations'},
                items: [{type: 'doc', id: 'operations/runbook'}],
              },
            ],
          },
        }],
      },
    },
    'docusaurus-plugin-content-pages': {
      default: {
        loadedPages: [{metadata: {title: 'Example Docs', permalink: '/', source: '@site/src/pages/index.tsx'}}],
      },
    },
  };
}
