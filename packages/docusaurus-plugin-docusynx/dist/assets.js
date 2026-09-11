import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const MIME_BY_EXTENSION = {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
};
export class AssetCollector {
    #assets = new Map();
    #outputDirectory;
    constructor(outputDirectory) {
        this.#outputDirectory = outputDirectory;
    }
    async add(sourcePath, mimeType) {
        const bytes = await readFile(sourcePath);
        const digest = createHash('sha256').update(bytes).digest('hex');
        const extension = path.extname(sourcePath).toLowerCase();
        const id = `sha256:${digest}`;
        const relativePath = `assets/${digest}${extension}`;
        if (!this.#assets.has(id)) {
            await mkdir(path.join(this.#outputDirectory, 'assets'), {
                recursive: true,
            });
            await copyFile(sourcePath, path.join(this.#outputDirectory, relativePath));
            this.#assets.set(id, {
                id,
                path: relativePath,
                mimeType: mimeType ??
                    MIME_BY_EXTENSION[extension] ??
                    'application/octet-stream',
                hash: id,
            });
        }
        return id;
    }
    values() {
        return [...this.#assets.values()].sort((left, right) => compareStrings(left.id, right.id));
    }
}
function compareStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
