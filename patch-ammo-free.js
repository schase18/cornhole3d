/**
 * Patches public/ammo.js to add a _free stub.
 *
 * The Babylon CDN ammo.js build was compiled WITHOUT _free in its Emscripten
 * EXPORTED_FUNCTIONS.  _malloc exists but _free is nowhere in the module.
 *
 * The only call site for _free is zC() — the temp-buffer cleanup helper used
 * by CreateFromTriMesh during soft-body creation.  A no-op _free leaks a few KB
 * of WASM heap per bag creation, which is negligible for this game.
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'public', 'ammo.js');
let src = fs.readFileSync(file, 'utf8');

const mallocLine =
  'b._malloc=function(){return(b._malloc=b.asm.Ez).apply(null,arguments)};';
const idx = src.indexOf(mallocLine);
if (idx === -1) {
  console.error('ERROR: _malloc binding not found in public/ammo.js');
  process.exit(1);
}

const freeStub = "b._free=function(){};";
src = src.replace(mallocLine, mallocLine + '\n' + freeStub);
fs.writeFileSync(file, src);
console.log('OK — no-op _free stub added to public/ammo.js');
