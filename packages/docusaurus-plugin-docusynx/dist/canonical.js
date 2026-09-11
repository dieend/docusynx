import { createHash } from 'node:crypto';
export function canonicalJson(value) {
    return JSON.stringify(canonicalize(value))
        .replaceAll('\u2028', '\\u2028')
        .replaceAll('\u2029', '\\u2029');
}
function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([key, entry]) => [key, canonicalize(entry)]));
    }
    return value;
}
export function contentHash(value) {
    return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
