import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('artifacts', { recursive: true });
await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: 'dist/extension.js', sourcemap: true,
  // unpdf bundles its own serverless pdf.js; these optional imports are never reached.
  external: ['vscode', 'pdfjs-dist', '@napi-rs/canvas'] });
console.log('Built Chatroom extension.');
