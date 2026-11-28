// Run this consumer against the packed library before and after esbuild --bundle --minify.
const assert = require('node:assert/strict');

const { runtimeBy } = require('@ton-community/tlb-runtime');

const runtime = runtimeBy('_ n:(## 3) x:(uint n) = Value;');
const data = { kind: 'Value', n: 3, x: 5 };
const cell = runtime.encodeCell(data);
assert.equal(cell.bits.length, 6);
assert.equal(cell.beginParse().loadUint(6), 0b011101);
assert.deepEqual(runtime.decodeCell(cell), data);

const grouped = runtimeBy('_ n:(## 8) { n >= 3 } ^[ a:uint8 ] = Grouped;');
const value = { kind: 'Grouped', n: 4, a: 7 };
const encoded = grouped.encodeCell(value);
assert.equal(encoded.beginParse().loadRef().beginParse().loadUint(8), 7);
assert.deepEqual(grouped.decodeCell(encoded), value);
assert.throws(() => grouped.encodeCell({ ...value, n: 2 }));
