// ============================================================
// WA-Bridge — esbuild Build Script
// ============================================================

import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const result = await build({
  entryPoints: [path.join(__dirname, 'src/index.ts')],
  bundle: true,
  outfile: path.join(__dirname, 'dist/index.js'),
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  external: [
    // Keep native modules external
    'bufferutil',
    'utf-8-validate',
    'sharp',
    // Keep large optional deps external
    '@hapi/boom',
    '@crysnovax/baileys',
    'jimp',
  ],
  sourcemap: true,
  minify: false,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'info',
}).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});

console.log('✅ Build complete → dist/index.js');
