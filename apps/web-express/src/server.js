// Starts the Express storefront. `npm run dev:express` at the repo root runs it with the Carts API.
import { loadEnv } from './env.js';

loadEnv();
// Imported after loadEnv(), so the SDK and the Carts API client see the repo-root .env.local.
const { createApp } = await import('./app.js');

// 3000, like apps/web, so the tenant's callback (http://localhost:3000/auth/callback) and `npm run tunnel` work unchanged.
const port = Number(process.env.PORT || 3000);

createApp().listen(port, (error) => {
  // Express 5 passes a listen error, such as a port in use, to this callback.
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log(`Drift Bean Demo (Express) listening on http://localhost:${port}`);
});
