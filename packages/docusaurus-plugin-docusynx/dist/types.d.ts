export interface MdxAstNode {
    type: string;
    name?: string | null;
    value?: string;
    children?: MdxAstNode[];
    attributes?: Array<{
        name?: string;
        type: string;
        value?: unknown;
    }>;
    [key: string]: unknown;
}
export type TextMark = 'bold' | 'italic' | 'strikethrough' | 'code';
export interface TextInline {
    type: 'text';
    value: string;
    marks?: TextMark[];
}
export interface LinkInline {
    type: 'link';
    target: {
        kind: 'url' | 'document';
        value: string;
    };
    children: Inline[];
}
export type Inline = TextInline | LinkInline;
export type Block = {
    type: 'paragraph';
    inlines: Inline[];
} | {
    type: 'heading';
    level: number;
    inlines: Inline[];
} | {
    type: 'code';
    language?: string;
    title?: string;
    value: string;
} | {
    type: 'mermaid';
    value: string;
} | {
    type: 'list';
    ordered: boolean;
    items: Block[][];
} | {
    type: 'table';
    header: Inline[][];
    rows: Inline[][][];
} | {
    type: 'admonition';
    kind: string;
    title?: string;
    blocks: Block[];
} | {
    type: 'image';
    assetId: string;
    alt?: string;
    title?: string;
} | {
    type: 'thematicBreak';
} | {
    type: 'extension';
    name: string;
    data: unknown;
};
export interface BundleSource {
    path: string;
    url?: string;
    commit?: string;
}
export interface BundleDocument {
    id: string;
    title: string;
    route: string;
    parentId?: string;
    order: number;
    source: BundleSource;
    blocks: Block[];
    hash: string;
}
export interface BundleAsset {
    id: string;
    path: string;
    mimeType: string;
    hash: string;
}
export interface DocumentBundle {
    schemaVersion: 1;
    site: {
        name: string;
        baseUrl: string;
        sourceBaseUrl?: string;
        sourceCommit?: string;
    };
    documents: BundleDocument[];
    assets: BundleAsset[];
    hash: string;
}
export type ComponentHandlerAssetInput = {
    path: string;
    mimeType?: string;
} | {
    content: string | Uint8Array;
    extension: '.svg';
    mimeType: 'image/svg+xml';
};
export interface ComponentHandlerContext {
    readonly node: MdxAstNode;
    readonly props: Readonly<Record<string, unknown>>;
    readonly children: readonly MdxAstNode[];
    readonly siteDir: string;
    readonly sourcePath: string;
    readSiteFile(path: string): Promise<string>;
    addAsset(input: ComponentHandlerAssetInput): Promise<string>;
    transformChildren(): Promise<Block[]>;
}
export interface ComponentHandler {
    transform(context: ComponentHandlerContext): Block | Block[] | Promise<Block | Block[]>;
}
export interface ComponentHandlerRegistration {
    importSource: string;
    exportName: string;
    handler: string | ComponentHandler;
}
export interface PluginOptions {
    siteName?: string;
    outputDirectory?: string;
    sourceBaseUrl?: string;
    sourceCommit?: string;
    sourcePathPrefix?: string;
    sourceUrlTemplate?: string;
    sourcePathMappings?: Array<{
        routePattern: string;
        sourcePath: string;
    }>;
    strict?: boolean;
    componentHandlers?: ComponentHandlerRegistration[];
    renderedRoutePatterns?: string[];
    excludeRoutePatterns?: string[];
    htmlContentSelectors?: string[];
}
export declare function defineComponentHandler(handler: ComponentHandler): ComponentHandler;
