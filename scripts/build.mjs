import { build } from 'esbuild';
await build({ entryPoints:['web/src/app.js'], bundle:true, minify:true, sourcemap:false, format:'esm', outfile:'backend/public/assets/app.js', target:['es2022'] });
console.log('VibeScore web build ready.');
