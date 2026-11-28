import { beginCell } from '@ton/core';

import { runtimeBy } from './index';

const wide = 1n << 53n;

it('compares wide integers exactly when reading and writing', () => {
    const runtime = runtimeBy('_ x:(## 64) y:(## 64) { x = y } = Eq;');
    const data = { kind: 'Eq', x: wide, y: wide };
    const pair = (y: bigint) => beginCell().storeUint(wide, 64).storeUint(y, 64).endCell();
    expect(runtime.encodeCell(data).equals(pair(wide))).toBe(true);
    expect(runtime.decodeCell(pair(wide))).toEqual(data);
    expect(() => runtime.encodeCell({ ...data, y: wide + 1n })).toThrow(/constraint/i);
    expect(() => runtime.decodeCell(pair(wide + 1n), { rootType: 'Eq' })).toThrow(/constraint/i);
});

it.each([0, 40])('reads bit %i without rounding or truncation', (bit) => {
    const runtime = runtimeBy(`_ flags:(## 64) x:(flags . ${bit})?uint8 = Flags;`);
    for (const set of [false, true]) {
        const flags = wide + (set ? 1n << BigInt(bit) : 0n);
        const builder = beginCell().storeUint(flags, 64);
        if (set) builder.storeUint(42, 8);
        const cell = builder.endCell();
        const data = runtime.decodeCell(cell, { rootType: 'Flags' });
        expect(data.flags).toBe(flags);
        expect(data.x).toBe(set ? 42 : undefined);
        expect(runtime.encodeCell(data).equals(cell)).toBe(true);
    }
});

it('rejects a width outside the safe integer range before reading a field', () => {
    const runtime = runtimeBy('_ n:(## 64) value:(uint n) = Box;');
    const cell = beginCell()
        .storeUint(wide + 1n, 64)
        .endCell();
    expect(() => runtime.decodeCell(cell, { rootType: 'Box' })).toThrow(/safe integer range/);
});
