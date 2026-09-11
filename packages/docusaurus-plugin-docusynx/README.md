# docusaurus-plugin-docusynx

This Docusaurus 3.10 plugin writes a deterministic document bundle to
`build/docusynx/manifest.json`. It exports content from
`@docusaurus/plugin-content-docs`, `@docusaurus/plugin-content-pages`, generated
documentation, and any remaining rendered route.

```ts
plugins: [
  [
    require.resolve('docusaurus-plugin-docusynx'),
    {
      siteName: 'product-docs',
      sourceBaseUrl: 'https://github.com/example/product-docs',
      sourceCommit: process.env.GITHUB_SHA,
      sourcePathPrefix: 'website',
      renderedRoutePatterns: ['/reference/api/**'],
      sourcePathMappings: [
        {
          routePattern: '/reference/api/**',
          sourcePath: 'path/to/openapi.yaml',
        },
      ],
      strict: true,
      componentHandlers: [
        {
          importSource: '@site/src/components/ComposeBlock',
          exportName: 'default',
          handler: require.resolve('./docusynx-handlers/compose-block'),
        },
      ],
    },
  ],
]
```

Normal Markdown and MDX documents use a structured source conversion. TypeScript
pages and routes selected by `renderedRoutePatterns` use the rendered `<main>`
element. This rendered mode supports Docusaurus theme components that produce
their content only during the build, including generated OpenAPI pages.

Component handlers are deterministic TypeScript modules. They convert a known
MDX component into target-neutral blocks:

```ts
import {defineComponentHandler} from 'docusaurus-plugin-docusynx';

export default defineComponentHandler({
  async transform(context) {
    return {
      type: 'code',
      language: 'yaml',
      value: await context.readSiteFile('static/docker-compose.yml'),
    };
  },
});
```

The handler key is the exact `importSource` and `exportName`. An unknown imported
MDX component stops the build. The plugin does not execute an unknown component.

`sourcePathPrefix` changes site-relative paths into repository-relative paths.
The `source_path` or `docusynx_source_path` frontmatter field overrides the path
with an already repository-relative value. The prefix is not applied to an
override.

`sourcePathMappings` maps generated route patterns to their repository source
files. A mapped path is already repository-relative and does not receive
`sourcePathPrefix`. A route that matches more than one mapping stops the build.
This rule prevents configuration order from changing the result.

The bundle schema is in `schema/document-bundle.schema.json`. Arrays use stable
ordering. Object keys use canonical JSON ordering. SHA-256 hashes exclude all
timestamps because the bundle has no timestamp fields.

Schema version 1 has these link limitations:

- A fragment-only link stays a URL anchor, such as `#installation`.
- A cross-page link with a fragment or query resolves to the plain document
  target. The fragment or query suffix is not preserved.
- Anchor-aware document targets require a future schema and target change.
