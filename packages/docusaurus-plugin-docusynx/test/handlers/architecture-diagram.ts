import {defineComponentHandler} from '../../src/index.js';

export default defineComponentHandler({
  async transform(context) {
    const assetId = await context.addAsset({
      path: 'static/img/architecture.svg',
      mimeType: 'image/svg+xml',
    });
    return {
      type: 'image',
      assetId,
      alt: String(context.props.alt ?? 'Architecture'),
    };
  },
});
