import type { Block, PluginOptions } from './types.js';
export interface CandidateDocument {
    id: string;
    title: string;
    route: string;
    sourcePath: string;
    sourcePathIsRepositoryRelative?: boolean;
    sourceAbsolutePath?: string;
    parentId?: string;
    order: number;
    syntheticBlocks?: Block[];
    forceRendered?: boolean;
    generatedIndexRoute?: string;
}
export declare function discoverDocuments(input: {
    allContent: unknown;
    routePaths: string[];
    siteDir: string;
    outDir: string;
    options: PluginOptions;
}): Promise<CandidateDocument[]>;
export declare function readRenderedRoute(outDir: string, route: string): Promise<string>;
export declare function normalizeRoute(route: string): string;
export declare function matchesRoutePattern(route: string, pattern: string): boolean;
