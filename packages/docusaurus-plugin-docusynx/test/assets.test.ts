import {mkdtemp, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {AssetCollector} from '../src/assets.js';

describe('generated assets', () => {
  it('writes and deduplicates content-addressed SVG assets', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'docusynx-assets-'));
    const assets = new AssetCollector(outputDirectory);

    const first = await assets.addBytes('<svg></svg>\n', '.svg', 'image/svg+xml');
    const second = await assets.addBytes('<svg></svg>\n', '.svg', 'image/svg+xml');

    expect(second).toBe(first);
    expect(assets.values()).toHaveLength(1);
    expect(assets.values()[0]).toMatchObject({id: first, mimeType: 'image/svg+xml', hash: first});
    expect(await readFile(path.join(outputDirectory, assets.values()[0]!.path), 'utf8')).toBe('<svg></svg>\n');
  });

  it('rejects invalid extensions and conflicting metadata', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'docusynx-assets-'));
    const assets = new AssetCollector(outputDirectory);
    await expect(assets.addBytes('asset', '../asset.svg', 'image/svg+xml')).rejects.toThrow(/invalid asset extension/);
    await assets.addBytes('<svg/>', '.svg', 'image/svg+xml');
    await expect(assets.addBytes('<svg/>', '.png', 'image/png')).rejects.toThrow(/metadata conflicts/);
  });

  it('accepts safe SVG references without changing the bytes', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'docusynx-assets-'));
    const assets = new AssetCollector(outputDirectory);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>.safe{fill:url(#paint)}</style><a href="https://example.com/docs"><image href="data:image/png;base64,aA=="/></a></svg>';

    const id = await assets.addBytes(svg, '.svg', 'image/svg+xml');

    expect(await readFile(path.join(outputDirectory, assets.values()[0]!.path), 'utf8')).toBe(svg);
    expect(id).toMatch(/^sha256:/);
  });

  it('accepts one normal XML declaration before the SVG root', async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'docusynx-assets-'));
    const assets = new AssetCollector(outputDirectory);
    const svg = '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"/>';
    await expect(assets.addBytes(svg, '.svg', 'image/svg+xml')).resolves.toMatch(/^sha256:/);
  });

  it.each([
    ['document type', '<!DOCTYPE svg><svg/>'],
    ['processing instruction', '<?unsafe value?><svg/>'],
    ['script', '<svg><script/></svg>'],
    ['event handler', '<svg onload="run()"/>'],
    ['set mutation', '<svg><set attributeName="href" to="https://evil.example/x"/></svg>'],
    ['animate reference', '<svg><animate href="https://evil.example/x" attributeName="x"/></svg>'],
    ['XML base', '<svg xml:base="https://evil.example/x"/>'],
    ['external reference', '<svg><image href="https://example.com/x.png"/></svg>'],
    ['CSS import', '<svg><style>@import "https://example.com/x.css"</style></svg>'],
    ['escaped CSS reference', String.raw`<svg><rect style="fill:u\000072l(https://example.com/x)"/></svg>`],
    ['malformed CSS reference', '<svg><rect style="fill:url(#paint"/></svg>'],
  ])('rejects handler-supplied SVG with %s', async (_name, svg) => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'docusynx-assets-'));
    const assets = new AssetCollector(outputDirectory);
    await expect(assets.addBytes(svg, '.svg', 'image/svg+xml')).rejects.toThrow(/unsafe SVG/);
    expect(assets.values()).toHaveLength(0);
  });
});
