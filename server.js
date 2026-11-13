// The entry point for a serverless host (Vercel). Not used by `npm start` or `npm run dev`.
//
// Why plain JavaScript: Vercel looks for a file named server / index / app that imports fastify.
// Given a TypeScript entry it compiles it with its own compiler setup, which fails on this project
// ("Cannot find type definition file for 'node'"). The build command already compiles src/ to dist/
// with the project's own tsc, so this file only hands over to that output: what runs on the host is
// what `node dist/server.js` runs anywhere else.
import 'fastify'; // marks this file as the Fastify entry for the host's detection
import './serverless-files.cjs'; // the folders the host must ship with the function (web/, config/)
import './dist/server.js'; // starts in serverless mode when process.env.VERCEL is set

// Never called. The ZIP table is loaded through a lazy require (src/geo/zip.ts) that the host's
// tracer cannot follow; this import() with a literal name is the form it can.
const alsoShipped = () => import('zipcodes');
void alsoShipped;
