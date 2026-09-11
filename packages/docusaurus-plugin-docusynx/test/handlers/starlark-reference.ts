import {defineComponentHandler} from '../../src/index.js';

export default defineComponentHandler({
  async transform(context) {
    const symbols = JSON.parse(await context.readSiteFile('static/data/starlark-reference.json')) as Record<
      string,
      {signature: string; description: string}
    >;
    const symbol = String(context.props.symbol);
    const entry = symbols[symbol];
    if (!entry) throw new Error(`unknown Starlark symbol ${symbol}`);
    return [
      {type: 'code', language: 'starlark', value: entry.signature},
      {type: 'paragraph', inlines: [{type: 'text', value: entry.description}]},
    ];
  },
});
