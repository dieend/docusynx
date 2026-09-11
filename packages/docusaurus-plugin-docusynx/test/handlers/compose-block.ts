import {defineComponentHandler} from '../../src/index.js';

export default defineComponentHandler({
  async transform(context) {
    return {
      type: 'code',
      language: 'yaml',
      title: 'docker-compose.yml',
      value: await context.readSiteFile('static/docker-compose.yml'),
    };
  },
});
