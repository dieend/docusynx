export type DiagramKind = 'excalidraw' | 'mermaid';
export declare function renderDiagramSvg(kind: DiagramKind, source: string): Promise<string>;
export declare function renderMermaidSvg(source: string): Promise<string>;
export declare function renderExcalidrawSvg(source: string): Promise<string>;
