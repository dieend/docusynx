import path from 'node:path';
import { load } from 'cheerio';
export async function renderedHtmlToBlocks(input) {
    const { $, root } = renderedContent(input.html, input.selectors);
    const title = root.find('h1').first().text().trim() ||
        $('title').text().split('|')[0]?.trim();
    const blocks = await transformElements($, root.children().toArray(), {
        ...input,
        strict: input.strict !== false,
    });
    return {
        ...(title ? { title } : {}),
        blocks,
    };
}
export function renderedHtmlLinkSemantics(input) {
    const { $, root } = renderedContent(input.html, input.selectors);
    const semantics = [];
    for (const element of root.find('a[href]').toArray()) {
        const anchor = $(element);
        const href = anchor.attr('href') ?? '';
        semantics.push({ href, text: normalizeVisibleText(anchor.text()) });
    }
    return semantics;
}
function renderedContent(html, selectors) {
    const $ = load(html);
    const contentSelectors = selectors ?? [
        'main article .theme-doc-markdown',
        'main article',
        'main',
    ];
    let root = $('body');
    for (const selector of contentSelectors) {
        const candidate = $(selector).first();
        if (candidate.length) {
            root = candidate;
            break;
        }
    }
    root.find('nav, footer, script, style, .theme-doc-toc-mobile, .theme-doc-toc-desktop, .pagination-nav, .breadcrumbs').remove();
    return { $, root };
}
async function transformElements($, nodes, context) {
    const blocks = [];
    for (const node of nodes) {
        if (node.type === 'text') {
            const value = $(node).text().trim();
            if (value)
                blocks.push({
                    type: 'paragraph',
                    inlines: [{ type: 'text', value }],
                });
            continue;
        }
        if (node.type !== 'tag')
            continue;
        const element = node;
        const name = element.name.toLowerCase();
        if (name === 'a') {
            const href = $(element).attr('href');
            const children = await transformElements($, element.children, context);
            rejectMeaningfulEmptyAnchor($, element, href ?? '', children.length, context);
            blocks.push(...(href
                ? applyLinkToBlocks(children, href, context)
                : children));
            continue;
        }
        if (/^h[1-6]$/.test(name)) {
            blocks.push({
                type: 'heading',
                level: Number(name.slice(1)),
                inlines: transformInlines($, element.children, context),
            });
            continue;
        }
        if (name === 'p') {
            const images = $(element).children('img');
            if (images.length === 1 && $(element).text().trim() === '') {
                blocks.push(await transformImage($, images.get(0), context));
            }
            else {
                blocks.push({
                    type: 'paragraph',
                    inlines: transformInlines($, element.children, context),
                });
            }
            continue;
        }
        if (name === 'pre') {
            const code = $(element).find('code').first();
            const language = classLanguage(code.attr('class'));
            const value = code.length
                ? code.text().replace(/\n$/, '')
                : $(element).text().replace(/\n$/, '');
            blocks.push(language === 'mermaid'
                ? { type: 'mermaid', value }
                : {
                    type: 'code',
                    ...(language ? { language } : {}),
                    value,
                });
            continue;
        }
        if (name === 'ul' || name === 'ol') {
            const items = [];
            for (const item of $(element).children('li').toArray()) {
                const childBlocks = await transformElements($, item.children, context);
                items.push(childBlocks.length
                    ? childBlocks
                    : [
                        {
                            type: 'paragraph',
                            inlines: transformInlines($, item.children, context),
                        },
                    ]);
            }
            blocks.push({ type: 'list', ordered: name === 'ol', items });
            continue;
        }
        if (name === 'table') {
            const rows = $(element)
                .find('tr')
                .toArray()
                .map((row) => $(row)
                .children('th,td')
                .toArray()
                .map((cell) => transformInlines($, cell.children, context)));
            blocks.push({
                type: 'table',
                header: rows[0] ?? [],
                rows: rows.slice(1),
            });
            continue;
        }
        if (name === 'img') {
            blocks.push(await transformImage($, element, context));
            continue;
        }
        if (name === 'hr') {
            blocks.push({ type: 'thematicBreak' });
            continue;
        }
        const className = $(element).attr('class') ?? '';
        if (name === 'blockquote' || className.split(/\s+/).includes('alert')) {
            const alertKind = className.match(/alert--([\w-]+)/)?.[1];
            blocks.push({
                type: 'admonition',
                kind: name === 'blockquote' ? 'quote' : (alertKind ?? 'note'),
                blocks: await transformElements($, element.children, context),
            });
            continue;
        }
        blocks.push(...(await transformElements($, element.children, context)));
    }
    return blocks.filter((block) => block.type !== 'paragraph' || block.inlines.length > 0);
}
function applyLinkToBlocks(blocks, href, context) {
    return blocks.map((block) => applyLinkToBlock(block, href, context));
}
function applyLinkToBlock(block, href, context) {
    switch (block.type) {
        case 'paragraph':
        case 'heading':
            if (containsLink(block.inlines))
                return unsupportedLinkedBlock(block, href, context, 'nested link');
            return {
                ...block,
                inlines: block.inlines.length === 0
                    ? block.inlines
                    : [
                        {
                            type: 'link',
                            target: { kind: 'url', value: href },
                            children: block.inlines,
                        },
                    ],
            };
        case 'list':
            return {
                ...block,
                items: block.items.map((item) => applyLinkToBlocks(item, href, context)),
            };
        case 'admonition':
            return {
                ...block,
                blocks: applyLinkToBlocks(block.blocks, href, context),
            };
        case 'table':
        case 'code':
        case 'mermaid':
        case 'image':
        case 'thematicBreak':
        case 'extension':
            return unsupportedLinkedBlock(block, href, context, 'unsupported block semantics');
        default:
            return assertNever(block);
    }
}
function unsupportedLinkedBlock(block, href, context, reason) {
    rejectUnsupportedLink(context, href, reason, block.type);
    return block;
}
function rejectUnsupportedLink(context, href, reason, blockType) {
    if (!context.strict)
        return;
    throw new Error(`cannot preserve block link on route ${context.route} for href ${href}: ${reason} for block type ${blockType}`);
}
function containsLink(inlines) {
    return inlines.some((inline) => inline.type === 'link');
}
function assertNever(value) {
    throw new Error(`unsupported rendered block: ${JSON.stringify(value)}`);
}
function transformInlines($, nodes, context, marks = []) {
    const result = [];
    for (const node of nodes) {
        if (node.type === 'text') {
            result.push({
                type: 'text',
                value: $(node).text(),
                ...(marks.length ? { marks: [...marks].sort() } : {}),
            });
            continue;
        }
        if (node.type !== 'tag')
            continue;
        const element = node;
        const name = element.name.toLowerCase();
        if (name === 'strong' || name === 'b')
            result.push(...transformInlines($, element.children, context, [
                ...marks,
                'bold',
            ]));
        else if (name === 'em' || name === 'i')
            result.push(...transformInlines($, element.children, context, [
                ...marks,
                'italic',
            ]));
        else if (name === 'del' || name === 's')
            result.push(...transformInlines($, element.children, context, [
                ...marks,
                'strikethrough',
            ]));
        else if (name === 'code')
            result.push(...transformInlines($, element.children, context, [
                ...marks,
                'code',
            ]));
        else if (name === 'a') {
            const href = $(element).attr('href') ?? '';
            if ($(element).find('img').length > 0)
                rejectUnsupportedLink(context, href, 'unsupported block semantics', 'image');
            const children = transformInlines($, element.children, context, marks);
            rejectMeaningfulEmptyAnchor($, element, href, children.length, context);
            result.push({
                type: 'link',
                target: { kind: 'url', value: href },
                children,
            });
        }
        else if (name === 'br')
            result.push({ type: 'text', value: '\n' });
        else
            result.push(...transformInlines($, element.children, context, marks));
    }
    return mergeText(result);
}
function rejectMeaningfulEmptyAnchor($, element, href, outputLength, context) {
    if (outputLength > 0)
        return;
    const anchor = $(element);
    const hasAccessibleText = Boolean(anchor.attr('aria-label')?.trim()) ||
        Boolean(anchor.attr('title')?.trim()) ||
        anchor.find('[aria-label], [title], [alt]').length > 0;
    const hasMeaningfulDescendant = element.children.some((child) => child.type === 'tag' || $(child).text().trim().length > 0);
    if (!hasAccessibleText && !hasMeaningfulDescendant)
        return;
    rejectUnsupportedLink(context, href, 'unsupported inline semantics', 'extension');
}
function normalizeVisibleText(value) {
    return value.replace(/\s+/g, ' ').trim();
}
async function transformImage($, element, context) {
    const source = $(element).attr('src') ?? '';
    if (/^(?:https?:)?\/\//.test(source) || source.startsWith('data:')) {
        return {
            type: 'extension',
            name: 'remoteImage',
            data: { url: source, alt: $(element).attr('alt') },
        };
    }
    const withoutQuery = source.split(/[?#]/)[0] ?? source;
    const basePrefix = `/${context.baseUrl.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
    const relative = withoutQuery.startsWith(basePrefix)
        ? withoutQuery.slice(basePrefix.length)
        : withoutQuery.replace(/^\/+/, '');
    const absolute = path.resolve(context.outDir, relative);
    const outputRelative = path.relative(path.resolve(context.outDir), absolute);
    if (outputRelative.startsWith('..') || path.isAbsolute(outputRelative)) {
        throw new Error(`rendered asset escapes the Docusaurus output directory: ${source}`);
    }
    const assetId = await context.assets.add(absolute);
    return {
        type: 'image',
        assetId,
        ...($(element).attr('alt') ? { alt: $(element).attr('alt') } : {}),
        ...($(element).attr('title')
            ? { title: $(element).attr('title') }
            : {}),
    };
}
function classLanguage(className) {
    return className?.match(/(?:^|\s)language-([\w-]+)/)?.[1];
}
function mergeText(inlines) {
    const result = [];
    for (const inline of inlines) {
        const previous = result.at(-1);
        if (inline.type === 'text' &&
            previous?.type === 'text' &&
            JSON.stringify(inline.marks ?? []) ===
                JSON.stringify(previous.marks ?? []))
            previous.value += inline.value;
        else
            result.push(inline);
    }
    return result;
}
