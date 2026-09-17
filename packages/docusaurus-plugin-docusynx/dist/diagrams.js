import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
const RENDER_TIMEOUT_MS = 30_000;
export async function renderDiagramSvg(kind, source) {
    if (!source.trim())
        throw new Error(`${kind} source is empty`);
    return new Promise((resolve, reject) => {
        const worker = new Worker(diagramWorkerUrl(), {
            workerData: { kind, source },
        });
        let settled = false;
        const timeout = setTimeout(() => {
            settled = true;
            void worker.terminate();
            reject(new Error(`${kind} renderer timed out`));
        }, RENDER_TIMEOUT_MS);
        worker.once('message', (message) => {
            clearTimeout(timeout);
            settled = true;
            if (typeof message !== 'object' ||
                message === null ||
                !('svg' in message) ||
                typeof message.svg !== 'string') {
                reject(new Error(`${kind} renderer returned an invalid response`));
                return;
            }
            resolve(message.svg);
        });
        worker.once('error', (error) => {
            clearTimeout(timeout);
            settled = true;
            reject(error);
        });
        worker.once('exit', (code) => {
            clearTimeout(timeout);
            if (!settled && code !== 0) {
                reject(new Error(`${kind} renderer exited with code ${code}`));
            }
            else if (!settled) {
                reject(new Error(`${kind} renderer exited without an SVG`));
            }
        });
    });
}
function diagramWorkerUrl() {
    const adjacent = new URL('./diagram-worker.js', import.meta.url);
    if (existsSync(fileURLToPath(adjacent)))
        return adjacent;
    const built = new URL('../dist/diagram-worker.js', import.meta.url);
    if (existsSync(fileURLToPath(built)))
        return built;
    return adjacent;
}
export async function renderMermaidSvg(source) {
    return renderDiagramSvg('mermaid', source);
}
export async function renderExcalidrawSvg(source) {
    return renderDiagramSvg('excalidraw', source);
}
