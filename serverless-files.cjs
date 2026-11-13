// Tells the serverless host which folders to ship with the function. Nothing here runs in the app.
//
// The host (Vercel) ships only the files its tracer can follow from server.js. It follows imports,
// and it understands exactly this shape, fs.readdirSync(path.join(__dirname, '<folder>')), as "the
// whole folder is needed". The app itself reaches these folders in ways the tracer cannot follow:
//   web/     the app shell, served by src/static.ts
//   config/  the prevailing-wage tables (a directory listing in src/market/prevailing.ts)
// CommonJS on purpose: __dirname is the form the tracer resolves most reliably.
const fs = require('node:fs');
const path = require('node:path');

module.exports = function shippedFolders() {
  return [
    fs.readdirSync(path.join(__dirname, 'web')),
    fs.readdirSync(path.join(__dirname, 'web', 'js')),
    fs.readdirSync(path.join(__dirname, 'web', 'js', 'views')),
    fs.readdirSync(path.join(__dirname, 'web', 'icons')),
    fs.readdirSync(path.join(__dirname, 'web', 'icons', 'screenshots')),
    fs.readdirSync(path.join(__dirname, 'web', 'icons', 'windows')),
    fs.readdirSync(path.join(__dirname, 'config')),
    fs.readdirSync(path.join(__dirname, 'config', 'prevailing-wage')),
  ];
};
