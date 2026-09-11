import type { AssetCollector } from './assets.js';
import type { Block, ComponentHandler, ComponentHandlerRegistration } from './types.js';
export declare function loadComponentHandlers(registrations: ComponentHandlerRegistration[]): Promise<Map<string, ComponentHandler>>;
export declare function markdownToBlocks(input: {
    source: string;
    siteDir: string;
    sourcePath: string;
    assets: AssetCollector;
    handlers: Map<string, ComponentHandler>;
    strict: boolean;
}): Promise<Block[]>;
