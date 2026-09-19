import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import matter from '@11ty/gray-matter';
import { AssetCollector } from './assets.js';
import { canonicalJson, contentHash } from './canonical.js';
import { discoverDocuments, matchesRoutePattern, normalizeRoute, readRenderedRoute, } from './discover.js';
import { renderedHtmlLinkSemantics, renderedHtmlToBlocks, } from './html.js';
import { loadComponentHandlers, markdownToBlocks } from './markdown.js';
export default function docusynxPlugin(context, options = {}) {
    let allContent = {};
    return {
        name: 'docusaurus-plugin-docusynx',
        allContentLoaded({ allContent: loadedContent }) {
            allContent = loadedContent;
        },
        async postBuild({ outDir, routesPaths = [], siteConfig }) {
            const strict = options.strict !== false;
            const siteBaseUrl = `${siteConfig.url ?? context.siteConfig.url ?? ''}${siteConfig.baseUrl ?? context.siteConfig.baseUrl ?? '/'}`;
            const outputDirectory = path.resolve(outDir, options.outputDirectory ?? 'docusynx');
            await mkdir(outputDirectory, { recursive: true });
            const assets = new AssetCollector(outputDirectory);
            const handlers = await loadComponentHandlers(options.componentHandlers ?? []);
            const candidates = await discoverDocuments({
                allContent,
                routePaths: routesPaths,
                siteDir: context.siteDir,
                outDir,
                options,
            });
            const documents = [];
            const renderedLinks = new Map();
            for (const candidate of candidates) {
                let title = candidate.title;
                let blocks;
                let rendered;
                let renderedHtml;
                if (strict ||
                    candidate.forceRendered ||
                    (!candidate.syntheticBlocks &&
                        !candidate.sourceAbsolutePath)) {
                    try {
                        renderedHtml = await readRenderedRoute(outDir, candidate.route);
                    }
                    catch (error) {
                        if (!candidate.syntheticBlocks)
                            throw error;
                    }
                }
                if (strict && renderedHtml)
                    renderedLinks.set(candidate.id, renderedHtmlLinkSemantics({
                        html: renderedHtml,
                        selectors: options.htmlContentSelectors,
                    }));
                if (renderedHtml &&
                    (candidate.forceRendered ||
                        (!candidate.syntheticBlocks &&
                            !candidate.sourceAbsolutePath)))
                    rendered = await renderedHtmlToBlocks({
                        html: renderedHtml,
                        outDir,
                        baseUrl: siteConfig.baseUrl ?? '/',
                        assets,
                        selectors: options.htmlContentSelectors,
                        route: candidate.route,
                        strict,
                    });
                if (candidate.syntheticBlocks) {
                    blocks = candidate.syntheticBlocks;
                }
                else if (candidate.forceRendered) {
                    if (!rendered)
                        throw new Error(`no rendered HTML found for route ${candidate.route}`);
                    title = rendered.title ?? title;
                    blocks = rendered.blocks;
                }
                else if (candidate.sourceAbsolutePath) {
                    const parsed = matter(await readFile(candidate.sourceAbsolutePath, 'utf8'));
                    blocks = await markdownToBlocks({
                        source: parsed.content,
                        siteDir: context.siteDir,
                        sourcePath: candidate.sourcePath,
                        assets,
                        handlers,
                        strict,
                    });
                }
                else {
                    if (!rendered)
                        throw new Error(`no rendered HTML found for route ${candidate.route}`);
                    title = rendered.title ?? title;
                    blocks = rendered.blocks;
                }
                const mappedSourcePath = sourcePathMapping(candidate.route, options.sourcePathMappings ?? []);
                const sourcePath = mappedSourcePath ??
                    (candidate.sourcePathIsRepositoryRelative
                        ? candidate.sourcePath
                            .replaceAll('\\', '/')
                            .replace(/^\.\//, '')
                        : prefixedSourcePath(candidate.sourcePath, options.sourcePathPrefix));
                const source = {
                    path: sourcePath,
                    ...sourceUrl(sourcePath, options),
                    ...(options.sourceCommit
                        ? { commit: options.sourceCommit }
                        : {}),
                };
                const withoutHash = {
                    id: candidate.id,
                    title,
                    route: normalizeRoute(candidate.route),
                    ...(candidate.parentId
                        ? { parentId: candidate.parentId }
                        : {}),
                    order: candidate.order,
                    source,
                    blocks,
                };
                documents.push({
                    ...withoutHash,
                    hash: contentHash(withoutHash),
                });
            }
            resolveDocumentLinks(documents, siteBaseUrl);
            if (strict)
                validateRenderedLinkParity({
                    documents,
                    renderedLinks,
                    siteBaseUrl,
                });
            for (const document of documents) {
                const { hash: _oldHash, ...withoutHash } = document;
                document.hash = contentHash(withoutHash);
            }
            documents.sort((left, right) => compareStrings(left.id, right.id));
            const site = {
                name: options.siteName ??
                    context.siteConfig.title ??
                    'Docusaurus',
                baseUrl: siteBaseUrl,
                ...(options.sourceBaseUrl
                    ? { sourceBaseUrl: options.sourceBaseUrl }
                    : {}),
                ...(options.sourceCommit
                    ? { sourceCommit: options.sourceCommit }
                    : {}),
            };
            const withoutHash = {
                schemaVersion: 1,
                site,
                documents,
                assets: assets.values(),
            };
            const bundle = {
                ...withoutHash,
                hash: contentHash(withoutHash),
            };
            await writeFile(path.join(outputDirectory, 'manifest.json'), `${canonicalJson(bundle)}\n`, 'utf8');
        },
    };
}
function compareStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function prefixedSourcePath(sourcePath, prefix) {
    const normalized = sourcePath.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!prefix || path.isAbsolute(normalized))
        return normalized;
    return `${prefix.replace(/^\/+|\/+$/g, '')}/${normalized}`;
}
function sourcePathMapping(route, mappings) {
    const normalizedRoute = normalizeRoute(route);
    const matches = mappings.filter((mapping) => matchesRoutePattern(normalizedRoute, mapping.routePattern));
    if (matches.length > 1) {
        throw new Error(`route ${normalizedRoute} matches multiple sourcePathMappings: ${matches.map((mapping) => mapping.routePattern).join(', ')}`);
    }
    const sourcePath = matches[0]?.sourcePath;
    if (!sourcePath)
        return undefined;
    if (path.isAbsolute(sourcePath) || sourcePath.split('/').includes('..')) {
        throw new Error(`sourcePathMappings sourcePath must be repository-relative: ${sourcePath}`);
    }
    return sourcePath.replaceAll('\\', '/').replace(/^\.\//, '');
}
function sourceUrl(sourcePath, options) {
    if (sourcePath.startsWith('.docusynx/') ||
        sourcePath.includes('/.docusynx/') ||
        sourcePath.startsWith('.docusaurus/') ||
        sourcePath.includes('/.docusaurus/') ||
        sourcePath.includes('/.generated/'))
        return {};
    const template = options.sourceUrlTemplate ??
        (options.sourceBaseUrl && options.sourceCommit
            ? `${options.sourceBaseUrl.replace(/\/$/, '')}/-/blob/{commit}/{path}`
            : undefined);
    if (!template)
        return {};
    return {
        url: template
            .replaceAll('{commit}', encodeURIComponent(options.sourceCommit ?? ''))
            .replaceAll('{path}', sourcePath.split('/').map(encodeURIComponent).join('/')),
    };
}
function resolveDocumentLinks(documents, siteBaseUrl) {
    const index = documentLinkIndex(documents, siteBaseUrl);
    for (const document of documents) {
        visitBlocks(document.blocks, (inline) => {
            if (inline.type !== 'link' || inline.target.kind !== 'url')
                return;
            const raw = inline.target.value;
            const target = documentTarget(raw, document, index);
            if (target) {
                inline.target = target;
                return;
            }
            if (!raw || /^(?:[a-z]+:|#)/i.test(raw))
                return;
            inline.target.value = absoluteDocusaurusUrl(raw, document, index);
        });
    }
}
function documentLinkIndex(documents, siteBaseUrl) {
    const byRoute = new Map();
    const bySource = new Map();
    for (const document of documents) {
        byRoute.set(normalizeRoute(document.route), document.id);
        bySource.set(stripExtension(document.source.path), document.id);
    }
    const siteUrl = new URL(siteBaseUrl || '/', 'https://docusynx.invalid/');
    return {
        byRoute,
        bySource,
        siteUrl,
        routePrefix: normalizeRoute(siteUrl.pathname),
    };
}
function documentTarget(raw, document, index) {
    if (!raw || raw.startsWith('#'))
        return undefined;
    let resolved;
    try {
        resolved = new URL(raw, documentUrl(document, index));
    }
    catch {
        return undefined;
    }
    if (!['http:', 'https:'].includes(resolved.protocol))
        return undefined;
    if (resolved.origin !== index.siteUrl.origin)
        return undefined;
    for (const route of linkRouteCandidates(resolved.pathname, index)) {
        const targetId = index.byRoute.get(route);
        if (targetId)
            return { kind: 'document', value: targetId };
    }
    if (/^(?:[a-z]+:|\/\/)/i.test(raw))
        return undefined;
    const withoutAnchor = raw.split(/[?#]/)[0] ?? raw;
    const sourcePath = stripExtension(path.posix.normalize(path.posix.join(path.posix.dirname(document.source.path), withoutAnchor)));
    const targetId = index.bySource.get(sourcePath);
    return targetId ? { kind: 'document', value: targetId } : undefined;
}
function linkRouteCandidates(pathname, index) {
    const candidates = new Set([normalizeRoute(pathname)]);
    const prefix = index.routePrefix;
    if (prefix !== '/' && normalizeRoute(pathname).startsWith(prefix)) {
        candidates.add(normalizeRoute(normalizeRoute(pathname).slice(prefix.length)));
    }
    return [...candidates];
}
function documentUrl(document, index) {
    const prefix = index.routePrefix === '/'
        ? ''
        : index.routePrefix.replace(/\/$/, '');
    return new URL(`${prefix}${normalizeRoute(document.route)}`, index.siteUrl);
}
function absoluteDocusaurusUrl(raw, document, index) {
    if (raw.startsWith('//'))
        return new URL(raw, index.siteUrl).href;
    if (raw.startsWith('/') &&
        index.routePrefix !== '/' &&
        !normalizeRoute(raw).startsWith(index.routePrefix)) {
        const prefix = index.routePrefix.replace(/\/$/, '');
        return new URL(`${prefix}${raw}`, index.siteUrl.origin).href;
    }
    return new URL(raw, documentUrl(document, index)).href;
}
function validateRenderedLinkParity(input) {
    const index = documentLinkIndex(input.documents, input.siteBaseUrl);
    for (const document of input.documents) {
        const rendered = input.renderedLinks.get(document.id);
        if (!rendered)
            continue;
        const expected = new Map();
        for (const link of rendered) {
            const target = documentTarget(link.href, document, index);
            if (target)
                appendLinkText(expected, target.value, link.text);
        }
        const actual = new Map();
        visitBlocks(document.blocks, (inline) => {
            if (inline.type === 'link' && inline.target.kind === 'document')
                appendLinkText(actual, inline.target.value, inlineText(inline.children));
        });
        const expectedSummary = linkTextSummary(expected);
        const actualSummary = linkTextSummary(actual);
        if (JSON.stringify(expectedSummary) === JSON.stringify(actualSummary))
            continue;
        throw new Error(`rendered internal link parity failed for route ${document.route}: expected ${JSON.stringify(expectedSummary)} but exported ${JSON.stringify(actualSummary)}`);
    }
}
function appendLinkText(links, targetId, text) {
    const values = links.get(targetId) ?? [];
    values.push(text);
    links.set(targetId, values);
}
function linkTextSummary(links) {
    return [...links.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([targetId, text]) => ({
        targetId,
        text: normalizeLinkText(text.join('')),
    }));
}
function inlineText(inlines) {
    return inlines
        .map((inline) => inline.type === 'text' ? inline.value : inlineText(inline.children))
        .join('');
}
function normalizeLinkText(value) {
    return value.replace(/\s+/g, '');
}
function visitBlocks(blocks, callback) {
    const visitInlines = (inlines) => {
        for (const inline of inlines) {
            callback(inline);
            if (inline.type === 'link')
                visitInlines(inline.children);
        }
    };
    for (const block of blocks) {
        if (block.type === 'paragraph' || block.type === 'heading')
            visitInlines(block.inlines);
        else if (block.type === 'table') {
            block.header.forEach(visitInlines);
            block.rows.flat().forEach(visitInlines);
        }
        else if (block.type === 'list')
            block.items.forEach((item) => visitBlocks(item, callback));
        else if (block.type === 'admonition')
            visitBlocks(block.blocks, callback);
    }
}
function stripExtension(value) {
    return value.replace(/\.(?:md|mdx)$/i, '').replace(/\/index$/i, '');
}
