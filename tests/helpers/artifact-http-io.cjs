// HTTP substitutes for the platform and OSS SDK boundary, shared by live and restarted workers.
require('../../scripts/register-typescript.cjs');
const { createGenerationImageSaver } = require('../../lib/generation/storage.ts');
exports.artifactHttpIO = base => ({
  fetch,
  save: createGenerationImageSaver({
    fetch, publicUrl: key => base + '/objects/' + key,
    client: {
      head: async (key, options) => {
        const response = await fetch(base + '/objects/' + key, { method: 'HEAD', signal: AbortSignal.timeout(options.timeout) });
        if (!response.ok) throw { status: response.status };
      },
      put: async (key, content, options) => {
        const response = await fetch(base + '/objects/' + key, {
          method: 'PUT', body: content, signal: AbortSignal.timeout(options.timeout), headers: options.headers,
        });
        if (!response.ok) throw { status: response.status };
      },
    },
  }),
});
