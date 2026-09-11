import { createHash } from 'node:crypto'

export function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalize(value))
        .replaceAll('\u2028', '\\u2028')
        .replaceAll('\u2029', '\\u2029')
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize)
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, entry]) => entry !== undefined)
                .sort(([left], [right]) =>
                    left < right ? -1 : left > right ? 1 : 0
                )
                .map(([key, entry]) => [key, canonicalize(entry)])
        )
    }
    return value
}

export function contentHash(value: unknown): string {
    return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}
