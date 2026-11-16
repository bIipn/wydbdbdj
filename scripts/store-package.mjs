#!/usr/bin/env node
// Rebuilds the Microsoft Store package from the LIVE web app manifest, through PWABuilder's packaging service
// (the same service pwabuilder.com calls when you click "Generate package"). See docs/MICROSOFT-STORE.md §3.
//
//   node scripts/store-package.mjs                      # version 1.0.1, classic 1.0.0, the vercel.app address
//   node scripts/store-package.mjs --version 1.0.2 --classic 1.0.1
//   node scripts/store-package.mjs --url https://your-domain.example/
//
// Writes out/store/BidSwipe-store.zip (out/ is gitignored) and prints what is inside. Upload the .msixbundle and
// the .classic.appxbundle to Partner Center. What it sends to the service: the app name, the three Store identity
// values below, the app's public address and its public manifest. None of that is secret; nothing else is sent.
//
// A manifest change needs a new package, and each new upload needs a higher version. The classic version must stay
// lower than the main one (the service refuses it otherwise).
// Behind a proxy (Claude's cloud sessions): run with NODE_USE_ENV_PROXY=1.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SERVICE = 'https://pwabuilder-windows-docker.azurewebsites.net/msix/generatezip';
// Partner Center → Product management → Product identity. If Partner Center ever shows other values, its values win.
const IDENTITY = { packageId: 'bidswipe.bidswipe', publisherId: 'CN=6A3385ED-1658-4BBF-A229-10E7AD5417AE', publisherName: 'bidswipe' };

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const url = arg('url', 'https://bidswipe-tau.vercel.app/').replace(/\/?$/, '/');
const version = arg('version', '1.0.1');
const classic = arg('classic', '1.0.0');
const three = /^\d+\.\d+\.\d+$/;
const asNumber = (v) => v.split('.').reduce((n, part) => n * 100000 + Number(part), 0);

const fail = (sentence) => {
  console.error(`store-package: ${sentence}`);
  process.exit(1);
};
if (!three.test(version) || !three.test(classic)) fail('versions are three numbers, like 1.0.1.');
if (asNumber(classic) >= asNumber(version)) fail(`the classic version (${classic}) must be lower than the version (${version}).`);
if (!url.startsWith('https://')) fail('the app address must start with https://.');

const manifestUrl = `${url}manifest.webmanifest`;
const manifestAnswer = await fetch(manifestUrl).catch((err) => fail(`could not read ${manifestUrl}: ${err.message}`));
if (!manifestAnswer.ok) fail(`${manifestUrl} answered ${manifestAnswer.status}.`);
const manifest = await manifestAnswer.json();
console.log(`manifest: "${manifest.name}", shortcuts ${manifest.shortcuts?.map((s) => s.name).join(' · ') ?? 'none'}, ${manifest.screenshots?.length ?? 0} screenshots`);

const body = {
  name: manifest.name ?? 'BidSwipe',
  packageId: IDENTITY.packageId,
  url,
  version,
  allowSigning: true,
  publisher: { displayName: IDENTITY.publisherName, commonName: IDENTITY.publisherId },
  generateModernPackage: true,
  classicPackage: { generate: true, version: classic, url },
  edgeHtmlPackage: { generate: false },
  manifestUrl,
  manifest,
  images: { baseImage: `${url}icons/icon-512.png`, backgroundColor: 'transparent', padding: 0 },
  resourceLanguage: 'en-us',
};

const answer = await fetch(SERVICE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .catch((err) => fail(`the packaging service did not answer: ${err.message}`));
const type = answer.headers.get('content-type') ?? '';
if (!answer.ok || !type.includes('zip')) fail(`the packaging service answered ${answer.status} (${type}): ${(await answer.text()).slice(0, 400)}`);

const zip = Buffer.from(await answer.arrayBuffer());
const dir = resolve('out', 'store');
mkdirSync(dir, { recursive: true });
const file = resolve(dir, 'BidSwipe-store.zip');
writeFileSync(file, zip);

// The file names sit in the zip's central directory; listing them needs no unzip library.
const names = new Set();
for (let at = zip.indexOf('PK\x01\x02', 0, 'latin1'); at >= 0; at = zip.indexOf('PK\x01\x02', at + 46, 'latin1')) {
  const length = zip.readUInt16LE(at + 28);
  names.add(zip.subarray(at + 46, at + 46 + length).toString('utf8'));
}
console.log(`wrote ${file} (${(zip.length / 1e6).toFixed(1)} MB), package ${IDENTITY.packageId} ${version} (classic ${classic}), start address ${url}`);
for (const name of names) console.log(`  ${name}`);
const need = [...names].filter((n) => n.endsWith('.msixbundle') || n.endsWith('.classic.appxbundle'));
if (need.length < 2) fail('the zip does not hold both an .msixbundle and a .classic.appxbundle: do not upload it.');
console.log(`upload to Partner Center: ${need.join(' and ')}`);
