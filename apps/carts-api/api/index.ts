// Vercel Function entry: every request is rewritten here by vercel.json. Configuration comes from the
// project's environment variables. The in-memory stores live per function instance, so carts and orders
// are not shared between instances or kept across cold starts.
import { buildApp } from '../src/bootstrap.js';

const { app } = await buildApp();

export default app;
