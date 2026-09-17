import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { toString } from 'mdast-util-to-string'
import remarkDirective from 'remark-directive'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { AssetCollector } from './assets.js'
import type {
    Block,
    ComponentHandler,
    ComponentHandlerContext,
    ComponentHandlerRegistration,
    Inline,
    MdxAstNode,
    TextMark,
} from './types.js'

type AstNode = MdxAstNode & {
    alt?: string
    attributes?: Array<{ name?: string; type: string; value?: unknown }>
    children?: AstNode[]
    depth?: number
    lang?: string | null
    meta?: string | null
    name?: string | null
    ordered?: boolean | null
    title?: string | null
    url?: string
    value?: string
}

interface MarkdownContext {
    siteDir: string
    sourcePath: string
    assets: AssetCollector
    handlers: Map<string, ComponentHandler>
    imports: Map<string, { importSource: string; exportName: string }>
    strict: boolean
}

export async function loadComponentHandlers(
    registrations: ComponentHandlerRegistration[]
): Promise<Map<string, ComponentHandler>> {
    const handlers = new Map<string, ComponentHandler>()
    for (const registration of registrations) {
        const key = handlerKey(
            registration.importSource,
            registration.exportName
        )
        if (handlers.has(key)) {
            throw new Error(`duplicate component handler for ${key}`)
        }
        if (typeof registration.handler === 'string') {
            const imported = (await import(
                pathToImportUrl(registration.handler)
            )) as {
                default?: ComponentHandler
                transform?: ComponentHandler['transform']
            }
            const handler = imported.default?.transform
                ? imported.default
                : imported.transform
                  ? { transform: imported.transform }
                  : undefined
            if (!handler) {
                throw new Error(
                    `component handler ${registration.handler} has no transform export`
                )
            }
            handlers.set(key, handler)
        } else {
            handlers.set(key, registration.handler)
        }
    }
    return handlers
}

function pathToImportUrl(value: string): string {
    if (value.startsWith('file:')) return value
    return new URL(`file://${path.resolve(value)}`).href
}

export async function markdownToBlocks(input: {
    source: string
    siteDir: string
    sourcePath: string
    assets: AssetCollector
    handlers: Map<string, ComponentHandler>
    strict: boolean
}): Promise<Block[]> {
    const processor = unified()
        .use(remarkParse)
        .use(remarkFrontmatter, ['yaml', 'toml'])
        .use(remarkGfm)
        .use(remarkDirective)
        .use(remarkMdx)
    const root = processor.parse(input.source) as unknown as {
        children: AstNode[]
    }
    const context: MarkdownContext = {
        ...input,
        imports: parseImports(input.source),
    }
    return transformBlockChildren(root.children, context)
}

async function transformBlockChildren(
    nodes: readonly AstNode[],
    context: MarkdownContext
): Promise<Block[]> {
    const blocks: Block[] = []
    for (const node of nodes) {
        blocks.push(...(await transformBlock(node, context)))
    }
    return blocks
}

async function transformBlock(
    node: AstNode,
    context: MarkdownContext
): Promise<Block[]> {
    switch (node.type) {
        case 'yaml':
        case 'toml':
        case 'mdxjsEsm':
            return []
        case 'paragraph': {
            const children = node.children ?? []
            if (children.length === 1 && children[0]?.type === 'image') {
                return [await transformImage(children[0], context)]
            }
            return [{ type: 'paragraph', inlines: transformInlines(children) }]
        }
        case 'heading':
            return [
                {
                    type: 'heading',
                    level: node.depth ?? 1,
                    inlines: transformInlines(node.children ?? []),
                },
            ]
        case 'code': {
            if (node.lang === 'mermaid')
                return [{ type: 'mermaid', value: node.value ?? '' }]
            const titleMatch = node.meta?.match(
                /(?:^|\s)title=(?:"([^"]+)"|'([^']+)'|(\S+))/
            )
            return [
                {
                    type: 'code',
                    ...(node.lang ? { language: node.lang } : {}),
                    ...(titleMatch
                        ? {
                              title:
                                  titleMatch[1] ??
                                  titleMatch[2] ??
                                  titleMatch[3],
                          }
                        : {}),
                    value: node.value ?? '',
                },
            ]
        }
        case 'list': {
            const items: Block[][] = []
            for (const item of node.children ?? []) {
                items.push(
                    await transformBlockChildren(item.children ?? [], context)
                )
            }
            return [{ type: 'list', ordered: node.ordered === true, items }]
        }
        case 'table': {
            const rows = (node.children ?? []).map((row: AstNode) =>
                (row.children ?? []).map((cell: AstNode) =>
                    transformInlines(cell.children ?? [])
                )
            )
            return [
                { type: 'table', header: rows[0] ?? [], rows: rows.slice(1) },
            ]
        }
        case 'blockquote':
            return [
                {
                    type: 'admonition',
                    kind: 'quote',
                    blocks: await transformBlockChildren(
                        node.children ?? [],
                        context
                    ),
                },
            ]
        case 'containerDirective':
        case 'leafDirective': {
            const title = directiveTitle(node)
            return [
                {
                    type: 'admonition',
                    kind: node.name ?? 'note',
                    ...(title ? { title } : {}),
                    blocks: await transformBlockChildren(
                        node.children ?? [],
                        context
                    ),
                },
            ]
        }
        case 'thematicBreak':
            return [{ type: 'thematicBreak' }]
        case 'mdxJsxFlowElement':
            return transformComponent(node, context)
        case 'mdxFlowExpression':
            if (
                !node.value?.trim() ||
                /^\/\*[\s\S]*\*\/$/.test(node.value.trim())
            )
                return []
            break
        case 'html':
            return [
                {
                    type: 'extension',
                    name: 'html',
                    data: { value: node.value ?? '' },
                },
            ]
        default:
            if (node.children)
                return transformBlockChildren(node.children, context)
    }
    if (context.strict) {
        throw new Error(
            `${context.sourcePath}: unsupported Markdown node ${node.type}`
        )
    }
    return [
        { type: 'extension', name: node.type, data: { value: toString(node) } },
    ]
}

async function transformComponent(
    node: AstNode,
    context: MarkdownContext
): Promise<Block[]> {
    const name = node.name
    if (!name)
        throw new Error(`${context.sourcePath}: an MDX component has no name`)
    if (/^[a-z]/.test(name)) {
        return transformBlockChildren(node.children ?? [], context)
    }
    const imported = context.imports.get(name)
    if (!imported) {
        throw new Error(
            `${context.sourcePath}: component ${name} has no static import`
        )
    }
    const key = handlerKey(imported.importSource, imported.exportName)
    const handler = context.handlers.get(key)
    if (!handler) {
        throw new Error(
            `${context.sourcePath}: unknown MDX component ${name} imported as ${imported.exportName} from ${imported.importSource}`
        )
    }
    const children = node.children ?? []
    const props = parseAttributes(node.attributes ?? [])
    const handlerContext: ComponentHandlerContext = {
        node,
        props,
        children,
        siteDir: context.siteDir,
        sourcePath: context.sourcePath,
        readSiteFile: async (requestedPath) =>
            readFile(resolveSitePath(context.siteDir, requestedPath), 'utf8'),
        addAsset: async (input) =>
            'path' in input
                ? context.assets.add(
                      resolveSitePath(context.siteDir, input.path),
                      input.mimeType
                  )
                : context.assets.addBytes(
                      input.content,
                      input.extension,
                      input.mimeType
                  ),
        transformChildren: async () =>
            transformBlockChildren(children, context),
    }
    const result = await handler.transform(handlerContext)
    return Array.isArray(result) ? result : [result]
}

function transformInlines(
    nodes: readonly AstNode[],
    marks: Array<'bold' | 'italic' | 'strikethrough' | 'code'> = []
): Inline[] {
    const inlines: Inline[] = []
    for (const node of nodes) {
        switch (node.type) {
            case 'text':
                inlines.push({
                    type: 'text',
                    value: node.value ?? '',
                    ...(marks.length ? { marks: [...marks].sort() } : {}),
                })
                break
            case 'inlineCode':
                inlines.push({
                    type: 'text',
                    value: node.value ?? '',
                    marks: [...marks, 'code' as TextMark].sort(),
                })
                break
            case 'strong':
                inlines.push(
                    ...transformInlines(node.children ?? [], [...marks, 'bold'])
                )
                break
            case 'emphasis':
                inlines.push(
                    ...transformInlines(node.children ?? [], [
                        ...marks,
                        'italic',
                    ])
                )
                break
            case 'delete':
                inlines.push(
                    ...transformInlines(node.children ?? [], [
                        ...marks,
                        'strikethrough',
                    ])
                )
                break
            case 'link':
                inlines.push({
                    type: 'link',
                    target: { kind: 'url', value: node.url ?? '' },
                    children: transformInlines(node.children ?? [], marks),
                })
                break
            case 'break':
                inlines.push({ type: 'text', value: '\n' })
                break
            case 'mdxTextExpression':
                if (node.value?.trim())
                    inlines.push({ type: 'text', value: `{${node.value}}` })
                break
            default:
                if (node.children)
                    inlines.push(...transformInlines(node.children, marks))
        }
    }
    return mergeAdjacentText(inlines)
}

async function transformImage(
    node: AstNode,
    context: MarkdownContext
): Promise<Block> {
    const url = node.url ?? ''
    if (/^(?:https?:)?\/\//.test(url) || url.startsWith('data:')) {
        return {
            type: 'extension',
            name: 'remoteImage',
            data: { url, alt: node.alt, title: node.title },
        }
    }
    const sourceDirectory = path.dirname(
        path.resolve(context.siteDir, context.sourcePath)
    )
    const absolutePath = url.startsWith('/')
        ? path.join(context.siteDir, 'static', url.replace(/^\/+/, ''))
        : path.resolve(sourceDirectory, url)
    const assetId = await context.assets.add(absolutePath)
    return {
        type: 'image',
        assetId,
        ...(node.alt ? { alt: node.alt } : {}),
        ...(node.title ? { title: node.title } : {}),
    }
}

function parseImports(
    source: string
): Map<string, { importSource: string; exportName: string }> {
    const imports = new Map<
        string,
        { importSource: string; exportName: string }
    >()
    const expression = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g
    for (const match of source.matchAll(expression)) {
        const clause = match[1]?.trim()
        const importSource = match[2]
        if (!clause || !importSource || clause.startsWith('type ')) continue
        const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)/)
        if (defaultMatch?.[1])
            imports.set(defaultMatch[1], {
                importSource,
                exportName: 'default',
            })
        const namedMatch = clause.match(/\{([\s\S]*?)\}/)
        for (const entry of namedMatch?.[1]?.split(',') ?? []) {
            const [exported, local] = entry.trim().split(/\s+as\s+/)
            if (exported)
                imports.set(local ?? exported, {
                    importSource,
                    exportName: exported,
                })
        }
    }
    return imports
}

function parseAttributes(
    attributes: AstNode['attributes']
): Record<string, unknown> {
    return Object.fromEntries(
        (attributes ?? [])
            .filter(
                (attribute: { name?: string; type: string; value?: unknown }) =>
                    attribute.name
            )
            .map(
                (attribute: {
                    name?: string
                    type: string
                    value?: unknown
                }) => [attribute.name as string, attribute.value ?? true]
            )
    )
}

function directiveTitle(node: AstNode): string | undefined {
    const first = node.children?.[0]
    if (first?.type === 'paragraph') {
        const value = toString(first).trim()
        if (value.startsWith('[') && value.endsWith(']'))
            return value.slice(1, -1)
    }
    return undefined
}

function mergeAdjacentText(inlines: Inline[]): Inline[] {
    const result: Inline[] = []
    for (const inline of inlines) {
        const previous = result.at(-1)
        if (
            inline.type === 'text' &&
            previous?.type === 'text' &&
            JSON.stringify(inline.marks ?? []) ===
                JSON.stringify(previous.marks ?? [])
        ) {
            previous.value += inline.value
        } else {
            result.push(inline)
        }
    }
    return result
}

function handlerKey(importSource: string, exportName: string): string {
    return `${importSource}#${exportName}`
}

function resolveSitePath(siteDir: string, requestedPath: string): string {
    const resolved = path.resolve(
        siteDir,
        requestedPath.replace(/^@site\//, '')
    )
    const relative = path.relative(path.resolve(siteDir), resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`path escapes the Docusaurus site: ${requestedPath}`)
    }
    return resolved
}
