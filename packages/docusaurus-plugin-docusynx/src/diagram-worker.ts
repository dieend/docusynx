import { createHash } from 'node:crypto'
import { parentPort, workerData } from 'node:worker_threads'
import type { DOMWindow } from 'jsdom'
import type { DiagramKind } from './diagrams.js'
import { assertSafeSvg } from './svg.js'

interface DiagramWorkerData {
    kind: DiagramKind
    source: string
}

interface ExcalidrawScene {
    elements: unknown[]
    appState?: {
        exportBackground?: boolean
        exportPadding?: number
        viewBackgroundColor?: string
    }
    files?: Record<string, unknown>
}

const input = workerData as DiagramWorkerData

async function renderMermaid(source: string): Promise<string> {
    const [{ createHTMLWindow }, { default: createDOMPurify }, { JSDOM }] =
        await Promise.all([
            import('svgdom'),
            import('dompurify'),
            import('jsdom'),
        ])
    const purificationWindow = new JSDOM('').window
    Object.assign(
        createDOMPurify,
        createDOMPurify(purificationWindow as never)
    )
    Object.defineProperty(globalThis, 'CSSStyleSheet', {
        configurable: true,
        value: purificationWindow.CSSStyleSheet,
    })
    const window = createHTMLWindow()
    Object.assign(globalThis, { window, document: window.document })
    const { default: mermaid } = await import('mermaid')
    const digest = createHash('sha256').update(source).digest('hex')
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
    })
    const { svg } = await mermaid.render(`docusynx-${digest.slice(0, 16)}`, source)
    return normalizeSvg(svg)
}

async function renderExcalidraw(source: string): Promise<string> {
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        pretendToBeVisual: true,
        url: 'http://localhost/',
    })
    installDomGlobals(dom.window)
    const scene = parseExcalidraw(source)
    validateExcalidrawFiles(scene.files ?? {})
    const excalidraw = (await import('@excalidraw/utils')) as unknown as {
        exportToSvg(input: unknown): Promise<{ outerHTML: string }>
    }
    const svg = await excalidraw.exportToSvg({
        data: {
            elements: scene.elements as never[],
            appState: {
                exportBackground: scene.appState?.exportBackground !== false,
                exportPadding: scene.appState?.exportPadding,
                exportScale: 1,
                viewBackgroundColor:
                    scene.appState?.viewBackgroundColor ?? '#ffffff',
                exportWithDarkMode: false,
                exportEmbedScene: false,
            },
            files: (scene.files ?? {}) as never,
        },
        config: { skipInliningFonts: true },
    })
    return normalizeSvg(svg.outerHTML)
}

function parseExcalidraw(source: string): ExcalidrawScene {
    let value: unknown
    try {
        value = JSON.parse(source)
    } catch (error) {
        throw new Error(`invalid Excalidraw JSON: ${errorMessage(error)}`)
    }
    if (
        typeof value !== 'object' ||
        value === null ||
        !('type' in value) ||
        value.type !== 'excalidraw' ||
        !('elements' in value) ||
        !Array.isArray(value.elements)
    ) {
        throw new Error('invalid Excalidraw scene')
    }
    return value as ExcalidrawScene
}

function validateExcalidrawFiles(files: Record<string, unknown>): void {
    for (const [fileID, file] of Object.entries(files)) {
        if (
            typeof file !== 'object' ||
            file === null ||
            !('dataURL' in file) ||
            typeof file.dataURL !== 'string' ||
            !isSafeRasterDataURL(file.dataURL)
        ) {
            throw new Error(
                `Excalidraw file ${JSON.stringify(fileID)} must use a base64 raster data URL`
            )
        }
    }
}

function installDomGlobals(window: DOMWindow): void {
    const values = window as unknown as Record<string, unknown>
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
        })
    }
    Object.defineProperty(globalThis, 'devicePixelRatio', {
        configurable: true,
        value: 1,
    })
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
        configurable: true,
        value: (callback: (time: number) => void) =>
            setTimeout(() => callback(0), 0),
    })
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
        configurable: true,
        value: clearTimeout,
    })
    Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: class {
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        },
    })
}

function normalizeSvg(svg: string): string {
    const normalized = svg.replaceAll('\r\n', '\n').trim()
    assertSafeSvg(normalized)
    return normalized + '\n'
}

function isSafeRasterDataURL(value: string): boolean {
    return /^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/]+={0,2}$/i.test(
        value
    )
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

const svg =
    input.kind === 'mermaid'
        ? await renderMermaid(input.source)
        : await renderExcalidraw(input.source)
parentPort?.postMessage({ svg })
