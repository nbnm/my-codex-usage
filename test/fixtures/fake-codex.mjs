#!/usr/bin/env node

if (process.argv[2] === '--version') {
  process.stdout.write('codex-cli 0.144.3\n');
} else if (process.argv[2] === 'app-server') {
  await import('./fake-app-server.mjs');
} else {
  process.exitCode = 2;
}
