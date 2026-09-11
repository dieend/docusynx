import {describe, expect, it} from 'vitest';
import {canonicalJson, contentHash} from '../src/index.js';

describe('canonical JSON', () => {
  it('sorts object keys but preserves array order', () => {
    expect(canonicalJson({z: 1, a: {d: 2, b: 1}, list: [2, 1]})).toBe(
      '{"a":{"b":1,"d":2},"list":[2,1],"z":1}',
    );
  });

  it('produces a stable SHA-256 hash', () => {
    expect(contentHash({b: 2, a: 1})).toBe(contentHash({a: 1, b: 2}));
  });

  it('matches Go JSON escaping for document characters', () => {
    expect(canonicalJson({text: '<&> café \u2028 \u2029'})).toBe(
      '{"text":"<&> café \\u2028 \\u2029"}',
    );
    expect(contentHash({text: '<&> café \u2028 \u2029'})).toBe(
      'sha256:cf7dc1fe1aa65d5813931535d28d7261c7b976628a369155b2d6a213d139af81',
    );
  });
});
