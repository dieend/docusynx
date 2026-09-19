import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from '@11ty/gray-matter';
export async function discoverDocuments(input) {
    const documents = new Map();
    let nextOrder = 0;
    for (const value of objectValuesDeep(input.allContent)) {
        const versions = arrayProperty(value, 'loadedVersions');
        if (versions) {
            for (const versionValue of versions) {
                const version = asRecord(versionValue);
                if (!version)
                    continue;
                const versionName = stringProperty(version, 'versionName') ??
                    stringProperty(version, 'name') ??
                    'current';
                const prefix = versionName === 'current' ? '' : `${versionName}:`;
                const docs = arrayProperty(version, 'docs') ?? [];
                for (const docValue of docs) {
                    const candidate = await candidateFromMetadata(docValue, input.siteDir, prefix, nextOrder++);
                    if (candidate)
                        documents.set(candidate.id, candidate);
                }
                applySidebars(version.sidebars, documents, prefix, () => nextOrder++);
            }
        }
        const pages = arrayProperty(value, 'loadedPages');
        if (pages) {
            for (const pageValue of pages) {
                const candidate = await candidateFromMetadata(pageValue, input.siteDir, 'page:', nextOrder++);
                if (candidate) {
                    // Pages can define local JSX components that have no stable import key.
                    // Their rendered <main> content is the deterministic public contract.
                    candidate.forceRendered = true;
                    documents.set(candidate.id, candidate);
                }
            }
        }
    }
    reconcileGeneratedIndexRoutes(documents, input.routePaths);
    const routeSet = new Set([...documents.values()].map((document) => normalizeRoute(document.route)));
    for (const route of [...input.routePaths].sort()) {
        const normalizedRoute = normalizeRoute(route);
        const exclusions = [
            '/404.html',
            '/404/',
            ...(input.options.excludeRoutePatterns ?? []),
        ];
        if (matchesAny(normalizedRoute, exclusions) ||
            matchesAny(route, exclusions))
            continue;
        if (routeSet.has(normalizedRoute))
            continue;
        if (!(await renderedRouteExists(input.outDir, normalizedRoute)))
            continue;
        const id = normalizedRoute === '/'
            ? 'page:index'
            : `route:${normalizedRoute.replace(/^\/|\/$/g, '')}`;
        documents.set(id, {
            id,
            title: normalizedRoute === '/'
                ? 'Home'
                : titleFromRoute(normalizedRoute),
            route: normalizedRoute,
            sourcePath: `.docusaurus/routes${normalizedRoute}index.html`,
            order: nextOrder++,
            forceRendered: true,
        });
    }
    for (const document of documents.values()) {
        if (matchesAny(document.route, input.options.renderedRoutePatterns ?? []))
            document.forceRendered = true;
    }
    return [...documents.values()].sort(compareCandidate);
}
async function candidateFromMetadata(value, siteDir, idPrefix, order) {
    const outer = asRecord(value);
    if (!outer)
        return undefined;
    const metadata = asRecord(outer.metadata) ?? outer;
    const route = stringProperty(metadata, 'permalink') ??
        stringProperty(metadata, 'route');
    const rawSource = stringProperty(metadata, 'source') ??
        stringProperty(metadata, 'sourcePath');
    if (!route || !rawSource)
        return undefined;
    const absolute = resolveSourcePath(siteDir, rawSource);
    let frontMatter = asRecord(metadata.frontMatter) ?? {};
    try {
        const parsed = matter(await readFile(absolute, 'utf8'));
        frontMatter = { ...parsed.data, ...frontMatter };
    }
    catch {
        // The rendered route remains available when a generated source is outside the site tree.
    }
    const routeId = normalizeRoute(route) === '/'
        ? 'index'
        : normalizeRoute(route).replace(/^\/|\/$/g, '');
    const rawId = stringProperty(frontMatter, 'docusynx_id') ??
        stringProperty(metadata, 'id') ??
        routeId;
    const sourceOverride = stringProperty(frontMatter, 'source_path') ??
        stringProperty(frontMatter, 'docusynx_source_path');
    return {
        id: `${idPrefix}${rawId}`,
        title: stringProperty(metadata, 'title') ??
            stringProperty(frontMatter, 'title') ??
            titleFromRoute(route),
        route: normalizeRoute(route),
        sourcePath: sourceOverride ?? normalizeSourcePath(siteDir, absolute, rawId),
        sourcePathIsRepositoryRelative: sourceOverride !== undefined,
        sourceAbsolutePath: absolute,
        order,
    };
}
function applySidebars(sidebarsValue, documents, prefix, nextOrder) {
    const sidebars = asRecord(sidebarsValue);
    if (!sidebars)
        return;
    for (const sidebarName of Object.keys(sidebars).sort()) {
        const items = Array.isArray(sidebars[sidebarName])
            ? sidebars[sidebarName]
            : [];
        walkSidebar(items, undefined, [sidebarName], documents, prefix, nextOrder);
    }
}
function walkSidebar(items, parentId, ancestry, documents, prefix, nextOrder) {
    items.forEach((itemValue, index) => {
        const item = asRecord(itemValue);
        if (!item)
            return;
        const type = stringProperty(item, 'type');
        if (type === 'doc') {
            const id = `${prefix}${stringProperty(item, 'id') ?? ''}`;
            if (id === parentId)
                return;
            const document = documents.get(id);
            if (document) {
                document.parentId = parentId;
                document.order = index;
            }
            return;
        }
        if (type !== 'category')
            return;
        const label = stringProperty(item, 'label') ?? 'Category';
        const link = asRecord(item.link);
        const explicitLinkedId = stringProperty(link ?? {}, 'type') === 'doc'
            ? `${prefix}${stringProperty(link ?? {}, 'id') ?? ''}`
            : undefined;
        const linkedId = explicitLinkedId ??
            indexDocumentId(item.items, documents, prefix);
        const id = linkedId && documents.has(linkedId)
            ? linkedId
            : `${prefix}category:${slug([...ancestry, label].join('/'))}`;
        if (!documents.has(id)) {
            const route = stringProperty(link ?? {}, 'slug') ??
                `/.docusynx/category/${slug([...ancestry, label].join('/'))}/`;
            const generatedIndexRoute = stringProperty(link ?? {}, 'type') === 'generated-index'
                ? normalizeRoute(route)
                : undefined;
            documents.set(id, {
                id,
                title: label,
                route: normalizeRoute(route),
                sourcePath: `.docusynx/categories/${slug([...ancestry, label].join('/'))}`,
                parentId,
                order: nextOrder(),
                syntheticBlocks: [
                    {
                        type: 'heading',
                        level: 1,
                        inlines: [{ type: 'text', value: label }],
                    },
                ],
                ...(generatedIndexRoute ? { generatedIndexRoute } : {}),
            });
        }
        else {
            const categoryDocument = documents.get(id);
            if (categoryDocument) {
                categoryDocument.parentId = parentId;
                categoryDocument.order = index;
            }
        }
        walkSidebar(Array.isArray(item.items) ? item.items : [], id, [...ancestry, label], documents, prefix, nextOrder);
    });
}
function indexDocumentId(itemsValue, documents, prefix) {
    if (!Array.isArray(itemsValue))
        return undefined;
    for (const itemValue of itemsValue) {
        const item = asRecord(itemValue);
        if (!item || stringProperty(item, 'type') !== 'doc')
            continue;
        const rawId = stringProperty(item, 'id') ?? '';
        const basename = rawId.split('/').at(-1);
        if (basename !== 'index' && basename !== 'overview')
            continue;
        const id = `${prefix}${rawId}`;
        if (documents.has(id))
            return id;
    }
    return undefined;
}
function reconcileGeneratedIndexRoutes(documents, routePaths) {
    const normalizedRoutes = [...new Set(routePaths.map(normalizeRoute))].sort();
    for (const document of documents.values()) {
        if (!document.generatedIndexRoute)
            continue;
        const suffix = document.generatedIndexRoute;
        const matches = normalizedRoutes.filter((route) => route === suffix || route.endsWith(suffix));
        if (matches.length > 1) {
            throw new Error(`generated-index category ${document.id} matches multiple rendered routes: ${matches.join(', ')}`);
        }
        const renderedRoute = matches[0];
        if (!renderedRoute)
            continue;
        document.route = renderedRoute;
        document.sourcePath = `.docusaurus/routes${renderedRoute}index.html`;
        document.sourcePathIsRepositoryRelative = false;
        document.syntheticBlocks = undefined;
        document.forceRendered = true;
    }
}
export async function readRenderedRoute(outDir, route) {
    for (const candidate of renderedRouteCandidates(outDir, route)) {
        try {
            return await readFile(candidate, 'utf8');
        }
        catch {
            // Try the next Docusaurus trailing-slash form.
        }
    }
    throw new Error(`no rendered HTML found for route ${route}`);
}
async function renderedRouteExists(outDir, route) {
    for (const candidate of renderedRouteCandidates(outDir, route)) {
        try {
            await access(candidate);
            return true;
        }
        catch {
            // Try the next form.
        }
    }
    return false;
}
function renderedRouteCandidates(outDir, route) {
    const relative = normalizeRoute(route).replace(/^\/+|\/+$/g, '');
    if (!relative)
        return [path.join(outDir, 'index.html')];
    return [
        path.join(outDir, relative, 'index.html'),
        path.join(outDir, `${relative}.html`),
    ];
}
function objectValuesDeep(value) {
    const results = [];
    const seen = new Set();
    const walk = (entry) => {
        if (entry === null || typeof entry !== 'object' || seen.has(entry))
            return;
        seen.add(entry);
        if (Array.isArray(entry)) {
            entry.forEach(walk);
            return;
        }
        const record = entry;
        results.push(record);
        Object.values(record).forEach(walk);
    };
    walk(value);
    return results;
}
function arrayProperty(record, key) {
    return Array.isArray(record[key]) ? record[key] : undefined;
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function stringProperty(record, key) {
    return typeof record[key] === 'string' ? record[key] : undefined;
}
function resolveSourcePath(siteDir, source) {
    if (path.isAbsolute(source))
        return source;
    return path.resolve(siteDir, source.replace(/^@site\//, ''));
}
function normalizeSourcePath(siteDir, source, documentId) {
    const relative = path.relative(siteDir, source);
    return relative.startsWith('..') || path.isAbsolute(relative)
        ? `.generated/${slug(documentId)}/${path.basename(source)}`
        : relative.replaceAll(path.sep, '/');
}
export function normalizeRoute(route) {
    const pathname = route.split(/[?#]/)[0] || '/';
    return `/${pathname.replace(/^\/+|\/+$/g, '')}${pathname === '/' ? '' : '/'}`;
}
function titleFromRoute(route) {
    const segment = route
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .at(-1) || 'Home';
    return segment
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function slug(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}
function matchesAny(value, patterns) {
    return patterns.some((pattern) => matchesRoutePattern(value, pattern));
}
export function matchesRoutePattern(route, pattern) {
    const expression = pattern
        .split('**')
        .map((part) => part.split('*').map(escapeExpression).join('[^/]*'))
        .join('.*');
    return new RegExp(`^${expression}$`).test(route);
}
function escapeExpression(value) {
    return value.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&');
}
function compareCandidate(left, right) {
    return left.order - right.order || compareStrings(left.id, right.id);
}
function compareStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
