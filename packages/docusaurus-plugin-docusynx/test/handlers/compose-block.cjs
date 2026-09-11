module.exports = {
  transform: async function transformComposeBlock(context) {
    return {
      type: 'code',
      language: 'yaml',
      title: 'docker-compose.yml',
      value: await context.readSiteFile('static/docker-compose.yml'),
    };
  },
};
