// ============================================================
// WA-Bridge — esbuild Build Script
// ============================================================

import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const outDir = process.env.OUT_DIR || 'dist';
const outPath = path.isAbsolute(outDir) ? outDir : path.join(__dirname, outDir);

const result = await build({
  entryPoints: [path.join(__dirname, 'src/index.ts')],
  bundle: true,
  outfile: path.join(outPath, 'index.js'),
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

const publicPath = path.join(outPath, 'public');
fs.rmSync(publicPath, { recursive: true, force: true });
fs.cpSync(path.join(__dirname, 'src/public'), publicPath, { recursive: true });
console.log(`✅ Build complete → ${outDir}/index.js`);
