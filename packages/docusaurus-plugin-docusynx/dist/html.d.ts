import type { AssetCollector } from './assets.js';
import type { Block } from './types.js';
export type RenderedLinkSemantic = {
    href: string;
    text: string;
};
export declare function renderedHtmlToBlocks(input: {
    html: string;
    outDir: string;
    baseUrl: string;
    assets: AssetCollector;
    selectors?: string[];
    route: string;
    strict?: boolean;
}): Promise<{
    title?: string;
    blocks: Block[];
}>;
export declare function renderedHtmlLinkSemantics(input: {
    html: string;
    selectors?: string[];
}): RenderedLinkSemantic[];
