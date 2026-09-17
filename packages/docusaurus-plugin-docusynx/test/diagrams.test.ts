import {describe, expect, it} from 'vitest';
import {renderExcalidrawSvg, renderMermaidSvg} from '../src/diagrams.js';

describe('diagram SVG renderers', () => {
  it.each([
    ['flowchart', 'flowchart TD\n  Source -->|Publish| Confluence', ['Source', 'Publish', 'Confluence']],
    ['sequence diagram', 'sequenceDiagram\n  Source->>Confluence: Publish SVG', ['Source', 'Publish SVG', 'Confluence']],
  ])('renders a Mermaid %s deterministically', async (_name, source, labels) => {
    const first = await renderMermaidSvg(source);
    const second = await renderMermaidSvg(source);

    expect(second).toBe(first);
    expect(first).toMatch(/^<svg[^>]+viewBox="[^"]+"/);
    for (const label of labels) {
      expect(first).toContain(label);
    }
  });

  it('renders an Excalidraw scene deterministically', async () => {
    const source = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      elements: [rectangle, text, image],
      appState: {viewBackgroundColor: '#ffffff', exportBackground: true},
      files: {pixel: embeddedPixel},
    });
    const first = await renderExcalidrawSvg(source);
    const second = await renderExcalidrawSvg(source);

    expect(second).toBe(first);
    expect(first).toMatch(/^<svg[^>]+viewBox="0 0 [^"]+"/);
    expect(first).toContain('svg-source:excalidraw');
    expect(first).toContain('Rendered diagram');
    expect(first).toContain(embeddedPixel.dataURL);
  });

  it('rejects invalid Excalidraw input', async () => {
    await expect(renderExcalidrawSvg('{}')).rejects.toThrow(/invalid Excalidraw scene/);
  });

  it('rejects a remote Excalidraw image', async () => {
    const source = JSON.stringify({
      type: 'excalidraw',
      elements: [],
      files: {
        remote: {
          dataURL: 'https://images.example/tracker.svg',
          id: 'remote',
          mimeType: 'image/svg+xml',
          created: 1,
        },
      },
    });
    await expect(renderExcalidrawSvg(source)).rejects.toThrow(/base64 raster data URL/);
  });

  it('rejects an escaped external CSS reference', async () => {
    const source = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      elements: [],
      appState: {
        exportBackground: true,
        viewBackgroundColor: String.raw`u\000072l(https://evil.example/x)`,
      },
      files: {},
    });

    await expect(renderExcalidrawSvg(source)).rejects.toThrow(/unsafe SVG/);
  });

  it('rejects invalid Mermaid input', async () => {
    await expect(renderMermaidSvg('not a diagram')).rejects.toThrow(/No diagram type detected/);
  });
});

const rectangle = {
  id: 'rectangle',
  type: 'rectangle',
  x: 10,
  y: 10,
  width: 100,
  height: 50,
  angle: 0,
  strokeColor: '#000000',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 1,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: 'a0',
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
};

const text = {
  ...rectangle,
  id: 'text',
  type: 'text',
  x: 20,
  y: 20,
  width: 160,
  height: 25,
  index: 'a1',
  fontSize: 20,
  fontFamily: 1,
  baseFontSize: null,
  text: 'Rendered diagram',
  textAlign: 'left',
  verticalAlign: 'top',
  containerId: null,
  originalText: 'Rendered diagram',
  autoResize: true,
  lineHeight: 1.25,
};

const image = {
  ...rectangle,
  id: 'image',
  type: 'image',
  x: 200,
  y: 10,
  width: 20,
  height: 20,
  index: 'a2',
  fileId: 'pixel',
  status: 'saved',
  scale: [1, 1],
  crop: null,
};

const embeddedPixel = {
  id: 'pixel',
  mimeType: 'image/png',
  dataURL:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  created: 1,
};
