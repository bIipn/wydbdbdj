// Rebuilds every PNG in web/icons/ from web/icon.svg (the one source of truth for the logo).
// Uses Playwright's Chromium to rasterize, so it needs no image library:
//   NODE_PATH=$(npm root -g) node scripts/make-icons.cjs        (Playwright installed globally)
// It lives outside web/ so the host never serves it as part of the app.
// Sizes follow Microsoft's "Define icons and a theme color" (PWA on Windows, levels 2–4):
// https://learn.microsoft.com/microsoft-edge/progressive-web-apps/how-to/icon-theme-color#icon-image-sizes
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const WEB = join(__dirname, '..', 'web');
const OUT = join(WEB, 'icons');
const svg = readFileSync(join(WEB, 'icon.svg'), 'utf8');
const BOLT = (svg.match(/<path d="([^"]+)"/) || [])[1];
if (!BOLT) throw new Error('make-icons: no <path d="…"> in web/icon.svg');

// The bolt sits in a 512 box. `scale` shrinks it around the centre (maskable icons need an 80% safe zone).
const bolt = (scale) => `<g transform="translate(256 256) scale(${scale}) translate(-246 -256)"><path d="${BOLT}" fill="#ffd43b"/></g>`;
const BG = `<defs><radialGradient id="g" cx="50%" cy="35%" r="70%"><stop offset="0" stop-color="#1c2430"/><stop offset="1" stop-color="#0a0d12"/></radialGradient></defs>`;

// Full-bleed square (no rounded corners): maskable icons and Windows tiles, which Windows shapes itself.
const square = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${BG}<rect width="512" height="512" fill="url(#g)"/>${bolt(scale)}</svg>`;
// Wide images (wide tile, splash): the mark in the middle of a dark band.
const wide = (w, h) => {
  const s = (h * 0.62) / 512; // bolt about 60% of the height
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><radialGradient id="g" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#1c2430"/><stop offset="1" stop-color="#0a0d12"/></radialGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/><g transform="translate(${w / 2} ${h / 2}) scale(${s}) translate(-246 -256)"><path d="${BOLT}" fill="#ffd43b"/></g></svg>`;
};

const jobs = [
  // Every browser: the rounded app icon as drawn in icon.svg (transparent corners).
  ['icon-192.png', 192, 192, svg],
  ['icon-512.png', 512, 512, svg],
  ['apple-touch-icon.png', 180, 180, square(0.78)], // iOS rounds it itself and shows black through transparency
  // Android / Chrome maskable: the bolt inside the inner 80% circle (scale 0.72 ⇒ bolt ≈ 0.72 × 368 = 265 px of 512).
  ['maskable-512.png', 512, 512, square(0.72)],
  ['maskable-192.png', 192, 192, square(0.72)],
  // Notification badge (Android status bar): only the shape counts, so a white bolt on transparent.
  ['badge-96.png', 96, 96, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g transform="translate(256 256) scale(1.15) translate(-246 -256)"><path d="${BOLT}" fill="#fff"/></g></svg>`],
  // Windows (PWABuilder). App icon (taskbar, Start list) and target sizes: the rounded icon, transparent corners.
  ...[44, 88, 176].map((n) => [`windows/app-${n}.png`, n, n, svg]),
  ...[16, 24, 32, 48, 256].map((n) => [`windows/target-${n}.png`, n, n, svg]),
  // Tiles (small 71, medium 150, large 310, each at 100% and 200%) and the store logo (50, 100): full bleed.
  ...[71, 142, 150, 300, 310, 620, 50, 100].map((n) => [`windows/square-${n}.png`, n, n, square(0.74)]),
  ['windows/wide-310x150.png', 310, 150, wide(310, 150)],
  ['windows/wide-620x300.png', 620, 300, wide(620, 300)],
  ['windows/splash-620x300.png', 620, 300, wide(620, 300)],
  ['windows/splash-1240x600.png', 1240, 600, wide(1240, 600)],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [file, w, h, markup] of jobs) {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${w}px;height:${h}px}</style>${markup}`);
    await page.screenshot({ path: join(OUT, file), omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
    console.log(`${file} ${w}x${h}`);
  }
  await browser.close();
})();
