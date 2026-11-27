import { beginCell, Cell, Dictionary } from '@ton/core';

import { parseTLB, runtimeBy } from './index';
import { TLBLib } from './tesdata';

const key = Dictionary.Keys.Uint(8);
const byte = Dictionary.Values.Uint(8);

function decodeByteDictionary(input: Cell) {
    const runtime = runtimeBy(TLBLib.HashmapE + '_ entries:(HashmapE 8 uint8) = Box;');
    const { entries } = runtime.decodeCell(input, { rootType: 'Box' });
    if (!(entries instanceof Dictionary)) throw new Error('Expected Dictionary');
    return entries;
}

it('preserves a decoded leaf when TON Core writes the dictionary', () => {
    const original = Dictionary.empty(key, byte).set(17, 42);
    const input = beginCell().storeDict(original).endCell();
    const entries = decodeByteDictionary(input);

    expect(entries.get(17)).toBe(42);
    expect(beginCell().storeDict(entries).endCell().equals(input)).toBe(true);
    entries.set(17, 43);
    const updated = beginCell().storeDict(entries).endCell();
    expect(updated.beginParse().loadDict(key, byte).get(17)).toBe(43);
});

it('keeps the value codec when the first entry is added after decoding', () => {
    const empty = beginCell().storeBit(false).endCell();
    const entries = decodeByteDictionary(empty);
    entries.set(17, 42);

    const updated = beginCell().storeDict(entries).endCell();
    expect(updated.beginParse().loadDict(key, byte).get(17)).toBe(42);
});

it('keeps a native codec for direct dictionaries with wide keys and reference leaves', () => {
    const runtime = parseTLB('_ entries:(Hashmap 48 ^Cell) = Box;');
    const key = Dictionary.Keys.BigUint(48);
    const codec = Dictionary.Values.Cell();
    const expected = Dictionary.empty(key, codec);
    const id = 1n << 40n;
    expected.set(id, beginCell().storeUint(42, 8).endCell());
    const input = beginCell().storeDictDirect(expected).endCell();
    const { entries } = runtime.decodeCell(input, { rootType: 'Box' });
    if (!(entries instanceof Dictionary)) throw new Error('Expected Dictionary');
    expect(beginCell().storeDictDirect(entries).endCell().equals(input)).toBe(true);
    entries.set(id, beginCell().storeUint(43, 8).endCell());
    const output = beginCell().storeDictDirect(entries).endCell();
    expect(output.beginParse().loadDictDirect(key, codec).get(id)?.beginParse().loadUint(8)).toBe(43);
});
