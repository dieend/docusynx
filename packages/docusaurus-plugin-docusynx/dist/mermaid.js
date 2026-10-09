import { renderMermaidSvg } from './diagrams.js';
/** Render once per distinct source, including diagrams in nested containers. */
export async function renderMermaidBlocks(blocks, assets, cache, title) {
    const result = [];
    // Keep worker memory bounded by rendering diagrams sequentially.
    for (const block of blocks) {
        switch (block.type) {
            case 'mermaid': {
                let assetId = cache.get(block.value);
                if (!assetId) {
                    const svg = await renderMermaidSvg(block.value);
                    assetId = await assets.addBytes(svg, '.svg', 'image/svg+xml');
                    cache.set(block.value, assetId);
                }
                result.push({ type: 'image', assetId, alt: `${title} diagram` });
                break;
            }
            case 'admonition':
                result.push({
                    ...block,
                    blocks: await renderMermaidBlocks(block.blocks, assets, cache, title),
                });
                break;
            case 'list': {
                const items = [];
                for (const item of block.items) {
                    items.push(await renderMermaidBlocks(item, assets, cache, title));
                }
                result.push({ ...block, items });
                break;
            }
            default:
                result.push(block);
        }
    }
    return result;
}
