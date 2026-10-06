import { build } from 'esbuild';
await build({ entryPoints: ['scripts/provider-smoke.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: 'artifacts/provider-smoke.cjs', external: ['vscode'] });
