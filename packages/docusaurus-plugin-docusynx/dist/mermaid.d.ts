import type { AssetCollector } from './assets.js';
import type { Block } from './types.js';
/** Render once per distinct source, including diagrams in nested containers. */
export declare function renderMermaidBlocks(blocks: Block[], assets: AssetCollector, cache: Map<string, string>, title: string): Promise<Block[]>;
