import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BundleAsset } from './types.js'
import { assertSafeSvg } from './svg.js'

const MIME_BY_EXTENSION: Record<string, string> = {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
}

export class AssetCollector {
    readonly #assets = new Map<string, BundleAsset>()
    readonly #outputDirectory: string

    constructor(outputDirectory: string) {
        this.#outputDirectory = outputDirectory
    }

    async add(sourcePath: string, mimeType?: string): Promise<string> {
        const bytes = await readFile(sourcePath)
        return this.addBytes(
            bytes,
            path.extname(sourcePath).toLowerCase(),
            mimeType
        )
    }

    async addBytes(
        content: string | Uint8Array,
        extension: string,
        mimeType?: string
    ): Promise<string> {
        if (!/^\.[a-z0-9]+$/.test(extension)) {
            throw new Error(`invalid asset extension ${JSON.stringify(extension)}`)
        }
        const bytes =
            typeof content === 'string' ? Buffer.from(content, 'utf8') : content
        const digest = createHash('sha256').update(bytes).digest('hex')
        const id = `sha256:${digest}`
        const relativePath = `assets/${digest}${extension}`
        const resolvedMimeType =
            mimeType ??
            MIME_BY_EXTENSION[extension] ??
            'application/octet-stream'
        if (
            extension === '.svg' ||
            resolvedMimeType.split(';', 1)[0]?.trim().toLowerCase() ===
                'image/svg+xml'
        ) {
            let svg: string
            try {
                svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            } catch {
                throw new Error('unsafe SVG content: invalid UTF-8')
            }
            assertSafeSvg(svg)
        }
        const existing = this.#assets.get(id)
        if (existing) {
            if (
                existing.path !== relativePath ||
                existing.mimeType !== resolvedMimeType
            ) {
                throw new Error(`asset metadata conflicts for ${id}`)
            }
        } else {
            await mkdir(path.join(this.#outputDirectory, 'assets'), {
                recursive: true,
            })
            await writeFile(path.join(this.#outputDirectory, relativePath), bytes)
            this.#assets.set(id, {
                id,
                path: relativePath,
                mimeType: resolvedMimeType,
                hash: id,
            })
        }
        return id
    }

    values(): BundleAsset[] {
        return [...this.#assets.values()].sort((left, right) =>
            compareStrings(left.id, right.id)
        )
    }
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}
