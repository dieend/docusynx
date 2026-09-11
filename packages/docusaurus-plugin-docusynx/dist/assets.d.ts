import type { BundleAsset } from './types.js';
export declare class AssetCollector {
    #private;
    constructor(outputDirectory: string);
    add(sourcePath: string, mimeType?: string): Promise<string>;
    values(): BundleAsset[];
}
