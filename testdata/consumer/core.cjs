const assert = require('node:assert/strict');
const test = require('node:test');

const { parseTLB, runtimeBy } = require('@ton-community/tlb-runtime');
const { Address, beginCell, Dictionary } = require('@ton/core');

test('accepts Cell and BitString instances created by the application', () => {
    const runtime = runtimeBy('_ child:^Cell bits:bits16 = Box;', { autoText: false });
    const child = beginCell().storeUint(255, 8).endCell();
    const bits = beginCell().storeUint(0xf13a, 16).endCell().bits;
    const wire = beginCell().storeRef(child).storeBits(bits).endCell();

    assert(runtime.encodeCell({ kind: 'Box', child, bits }).equals(wire));
    const record = runtime.decodeCell(wire);
    assert(record.child.equals(child));
    assert(record.bits.equals(bits));
});

test('accepts an Address created by the application', () => {
    const runtime = runtimeBy('addr_std$10 = MsgAddressInt; _ address:MsgAddressInt = Box;');
    const address = new Address(0, Buffer.alloc(32, 7));
    const wire = beginCell().storeAddress(address).endCell();
    assert(runtime.encodeCell({ kind: 'Box', address }).equals(wire));
});

test('accepts a Dictionary created by the application', () => {
    const runtime = parseTLB('_ entries:(HashmapE 8 uint16) = Box;');
    const entries = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Uint(16)).set(3, 451);
    const wire = beginCell().storeDict(entries).endCell();
    assert(runtime.encodeCell({ kind: 'Box', entries }).equals(wire));
});
