import { loadRootEnv } from './env.js';

// Load the repo-root .env.local, .env.development.local and .env (see env.ts). Variables already in the environment win.
loadRootEnv();

// Imported after the env file loads, because building the app reads the configuration.
const { buildApp } = await import('./bootstrap.js');
const { app, config, agents } = await buildApp();

app.listen(config.port, (error?: Error) => {
  if (error) {
    throw error;
  }
  console.log(
    `carts-api listening on ${config.baseUrl}: audience ${config.audience}, ${agents.length} registered agent(s)` +
      (config.publicOrigin ? `, public origin ${config.publicOrigin}` : '')
  );
});
