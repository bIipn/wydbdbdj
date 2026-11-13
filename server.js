// The entry point for a serverless host (Vercel). Not used by `npm start` or `npm run dev`.
//
// Why plain JavaScript: Vercel looks for a file named server / index / app that imports fastify.
// Given a TypeScript entry it compiles it with its own compiler setup, which fails on this project
// ("Cannot find type definition file for 'node'"). The build command already compiles src/ to dist/
// with the project's own tsc, so this file only hands over to that output: what runs on the host is
// what `node dist/server.js` runs anywhere else.
import 'fastify'; // marks this file as the Fastify entry for the host's detection
import './dist/server.js'; // starts in serverless mode when process.env.VERCEL is set

// Never called. The host ships only the files its tracer can follow from this entry, and the app
// reaches these two in ways it cannot follow: the ZIP table through a lazy require (src/geo/zip.ts)
// and the prevailing-wage tables through a directory listing (src/market/prevailing.ts).
// test/serverless-entry.test.ts fails if a table in config/prevailing-wage/ is missing here.
const shippedWithTheFunction = () => [
  import('zipcodes'),
  new URL('./config/prevailing-wage/nevada-2026-2027.json', import.meta.url),
];
void shippedWithTheFunction;
