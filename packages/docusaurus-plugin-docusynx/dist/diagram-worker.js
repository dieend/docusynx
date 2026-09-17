import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { assertSafeSvg } from './svg.js';
const input = workerData;
async function renderMermaid(source) {
    const [{ createHTMLWindow }, { default: createDOMPurify }, { JSDOM }] = await Promise.all([
        import('svgdom'),
        import('dompurify'),
        import('jsdom'),
    ]);
    const purificationWindow = new JSDOM('').window;
    Object.assign(createDOMPurify, createDOMPurify(purificationWindow));
    Object.defineProperty(globalThis, 'CSSStyleSheet', {
        configurable: true,
        value: purificationWindow.CSSStyleSheet,
    });
    const window = createHTMLWindow();
    Object.assign(globalThis, { window, document: window.document });
    const { default: mermaid } = await import('mermaid');
    const digest = createHash('sha256').update(source).digest('hex');
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        flowchart: {
            htmlLabels: false,
        },
        deterministicIds: true,
        deterministicIDSeed: digest,
        theme: 'neutral',
    });
    const { svg } = await mermaid.render(`docusynx-${digest.slice(0, 16)}`, source);
    return normalizeSvg(svg);
}
async function renderExcalidraw(source) {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        pretendToBeVisual: true,
        url: 'http://localhost/',
    });
    installDomGlobals(dom.window);
    const scene = parseExcalidraw(source);
    validateExcalidrawFiles(scene.files ?? {});
    const excalidraw = (await import('@excalidraw/utils'));
    const svg = await excalidraw.exportToSvg({
        data: {
            elements: scene.elements,
            appState: {
                exportBackground: scene.appState?.exportBackground !== false,
                exportPadding: scene.appState?.exportPadding,
                exportScale: 1,
                viewBackgroundColor: scene.appState?.viewBackgroundColor ?? '#ffffff',
                exportWithDarkMode: false,
                exportEmbedScene: false,
            },
            files: (scene.files ?? {}),
        },
        config: { skipInliningFonts: true },
    });
    return normalizeSvg(svg.outerHTML);
}
function parseExcalidraw(source) {
    let value;
    try {
        value = JSON.parse(source);
    }
    catch (error) {
        throw new Error(`invalid Excalidraw JSON: ${errorMessage(error)}`);
    }
    if (typeof value !== 'object' ||
        value === null ||
        !('type' in value) ||
        value.type !== 'excalidraw' ||
        !('elements' in value) ||
        !Array.isArray(value.elements)) {
        throw new Error('invalid Excalidraw scene');
    }
    return value;
}
function validateExcalidrawFiles(files) {
    for (const [fileID, file] of Object.entries(files)) {
        if (typeof file !== 'object' ||
            file === null ||
            !('dataURL' in file) ||
            typeof file.dataURL !== 'string' ||
            !isSafeRasterDataURL(file.dataURL)) {
            throw new Error(`Excalidraw file ${JSON.stringify(fileID)} must use a base64 raster data URL`);
        }
    }
}
function installDomGlobals(window) {
    const values = window;
    for (const name of [
        'Blob',
        'CSSStyleDeclaration',
        'CSSStyleSheet',
        'DOMParser',
        'Element',
        'FileReader',
        'HTMLCanvasElement',
        'HTMLElement',
        'HTMLImageElement',
        'Image',
        'Node',
        'SVGElement',
        'XMLSerializer',
        'document',
        'getComputedStyle',
        'navigator',
        'window',
    ]) {
        Object.defineProperty(globalThis, name, {
            configurable: true,
            value: values[name],
        });
    }
    Object.defineProperty(globalThis, 'devicePixelRatio', {
        configurable: true,
        value: 1,
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
        configurable: true,
        value: (callback) => setTimeout(() => callback(0), 0),
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
        configurable: true,
        value: clearTimeout,
    });
    Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: class {
            observe() { }
            unobserve() { }
            disconnect() { }
        },
    });
}
function normalizeSvg(svg) {
    const normalized = svg.replaceAll('\r\n', '\n').trim();
    assertSafeSvg(normalized);
    return normalized + '\n';
}
function isSafeRasterDataURL(value) {
    return /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/]+={0,2}$/i.test(value);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
const svg = input.kind === 'mermaid'
    ? await renderMermaid(input.source)
    : await renderExcalidraw(input.source);
parentPort?.postMessage({ svg });
