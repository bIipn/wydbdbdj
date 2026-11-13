// PM2: `npm ci && npm run build && pm2 start ecosystem.config.cjs && pm2 save`
// One process on purpose — it serves the app AND runs the daily scan (SCAN_DAILY_AT in .env),
// because the embedded database can only be opened by one process at a time.
module.exports = {
  apps: [
    {
      name: 'bidswipe',
      script: 'dist/server.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '400M',
      time: true,
    },
  ],
};
