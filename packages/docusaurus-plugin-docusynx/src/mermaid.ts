import type { AssetCollector } from './assets.js'
import { renderMermaidSvg } from './diagrams.js'
import type { Block } from './types.js'

/** Render once per distinct source, including diagrams in nested containers. */
export async function renderMermaidBlocks(
    blocks: Block[],
    assets: AssetCollector,
    cache: Map<string, string>,
    title: string
): Promise<Block[]> {
    const result: Block[] = []
    // Keep worker memory bounded by rendering diagrams sequentially.
    for (const block of blocks) {
        switch (block.type) {
            case 'mermaid': {
                let assetId = cache.get(block.value)
                if (!assetId) {
                    const svg = await renderMermaidSvg(block.value)
                    assetId = await assets.addBytes(svg, '.svg', 'image/svg+xml')
                    cache.set(block.value, assetId)
                }
                result.push({ type: 'image', assetId, alt: `${title} diagram` })
                break
            }
            case 'admonition':
                result.push({
                    ...block,
                    blocks: await renderMermaidBlocks(block.blocks, assets, cache, title),
                })
                break
            case 'list': {
                const items: Block[][] = []
                for (const item of block.items) {
                    items.push(await renderMermaidBlocks(item, assets, cache, title))
                }
                result.push({ ...block, items })
                break
            }
            default:
                result.push(block)
        }
    }
    return result
}
