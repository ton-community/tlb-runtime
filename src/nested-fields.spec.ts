import { Address, beginCell, ExternalAddress } from '@ton/core';

import { runtimeBy, parseTLB, TLBDataError } from './index';
import { TLBLib, TLBStd } from './tesdata';

describe('variable-width numeric type arguments', () => {
    it('reads Box (Maybe (uint n)) when only Outer declares n', () => {
        const runtime = runtimeBy(TLBStd.Maybe + '_ {X:Type} v:X = Box X; _ n:uint4 p:(Box (Maybe (uint n))) = Outer;');
        const wire = beginCell().storeUint(3, 4).storeBit(true).storeUint(6, 3).endCell();
        const data = { kind: 'Outer', n: 3, p: { kind: 'Box', v: { kind: 'Maybe_just', value: 6 } } };
        expect(runtime.decodeCell(wire, { rootType: 'Outer' })).toEqual(data);
        expect(runtime.encodeCell(data).equals(wire)).toBe(true);
    });

    it.each([
        ['Maybe (uint n)', 3],
        ['Maybe (uint (n + 1))', 4],
    ] as const)('binds the outer width in Box (%s)', (argument, width) => {
        const runtime = runtimeBy(
            TLBStd.Maybe + `_ {X:Type} n:uint4 v:X = Box X; _ n:uint4 p:(Box (${argument})) = Outer;`,
        );
        const wire = beginCell().storeUint(3, 4).storeUint(1, 4).storeBit(true).storeUint(6, width).endCell();
        const data = { kind: 'Outer', n: 3, p: { kind: 'Box', n: 1, v: { kind: 'Maybe_just', value: 6 } } };
        expect(runtime.decodeCell(wire, { rootType: 'Outer' })).toEqual(data);
        expect(runtime.encodeCell(data).equals(wire)).toBe(true);
    });

    it.each(['##', 'uint', 'int'])('reads Maybe (%s n) with the width in the enclosing cell', (type) => {
        const r = runtimeBy(TLBStd.Maybe + `_ n:uint4 field:(Maybe (${type} n)) = Root;`);
        const cell = beginCell().storeUint(3, 4).storeBit(true).storeUint(6, 3).endCell();
        expect(r.decodeCell(cell, { rootType: 'Root' })).toEqual({
            kind: 'Root',
            n: 3,
            field: { kind: 'Maybe_just', value: type === 'int' ? -2 : 6 },
        });
    });

    it.each([
        [0, 3, 6, 'Either_left'],
        [1, 8, 129, 'Either_right'],
    ] as const)('preserves both Either parameter slots for tag %i', (tag, width, value, kind) => {
        const r = runtimeBy(TLBStd.Either + '_ n:uint4 field:(Either (uint n) uint8) = Root;');
        const cell = beginCell().storeUint(3, 4).storeBit(tag).storeUint(value, width).endCell();
        expect(r.decodeCell(cell, { rootType: 'Root' })).toEqual({
            kind: 'Root',
            n: 3,
            field: { kind, value },
        });
    });
});

const none = null;
const external = new ExternalAddress(9n, 4);
const internal = new Address(0, Buffer.alloc(32, 7));

describe.each([runtimeBy, parseTLB])('address tags with %p', (compile) => {
    function addressRuntime(type: string) {
        return compile(TLBLib.MsgAddress + `_ address:${type} = Root;`);
    }

    it.each(['MsgAddress', 'MsgAddressInt', 'MsgAddressExt'])('requires two bits for %s', (type) => {
        const runtime = addressRuntime(type);
        for (const builder of [beginCell(), beginCell().storeBit(0), beginCell().storeBit(1)]) {
            expect(() => runtime.decodeCell(builder.endCell(), { rootType: 'Root' })).toThrow(TLBDataError);
        }
    });

    it.each([
        ['MsgAddress', none],
        ['MsgAddress', external],
        ['MsgAddress', internal],
        ['MsgAddressExt', none],
        ['MsgAddressExt', external],
        ['MsgAddressInt', internal],
    ] as const)('accepts %s with %s', (type, address) => {
        const runtime = addressRuntime(type);
        const wire = beginCell().storeAddress(address).endCell();
        const decoded = runtime.decodeCell(wire, { rootType: 'Root' });
        expect(String(decoded.address)).toBe(String(address));
        expect(runtime.encodeCell({ kind: 'Root', address }).equals(wire)).toBe(true);
    });

    it.each([
        ['MsgAddressInt', none],
        ['MsgAddressInt', external],
        ['MsgAddressExt', internal],
    ] as const)('rejects %s with %s', (type, address) => {
        const runtime = addressRuntime(type);
        const wire = beginCell().storeAddress(address).endCell();
        expect(() => runtime.decodeCell(wire, { rootType: 'Root' })).toThrow(/Invalid address tag/);
        expect(() => runtime.encodeCell({ kind: 'Root', address })).toThrow(/Invalid address value/);
    });

    it.each([
        ['MsgAddress', /addr_var/],
        ['MsgAddressInt', /addr_var/],
        ['MsgAddressExt', /Invalid address tag/],
    ] as const)('diagnoses addr_var in %s', (type, error) => {
        const variable = beginCell()
            .storeUint(3, 2)
            .storeBit(0)
            .storeUint(8, 9)
            .storeInt(0, 32)
            .storeUint(42, 8)
            .endCell();
        expect(() => addressRuntime(type).decodeCell(variable, { rootType: 'Root' })).toThrow(error);
    });
});

it.each([
    ['_ {n:#} len:(#< n) value:(uint (len * 8)) = VarUInteger n;', '(VarUInteger 16)', 42n],
    ['custom$_ {n:#} len:(#< n) value:(int (len * 8)) = VarInteger n;', '(VarInteger 16)', -42n],
    ['_ amount:(VarUInteger 16) = Grams;', 'Grams', 42n],
] as const)('round-trips a scalar with the declared %s constructor', (declaration, type, value) => {
    const r = runtimeBy(declaration + `_ amount:${type} = Box;`);
    const wire = beginCell().storeUint(1, 4).storeInt(value, 8).endCell();
    const data = r.decodeCell(wire, { rootType: 'Box' });
    expect(data.amount).toBe(value);
    expect(r.encodeCell(data).equals(wire)).toBe(true);
});

it.each([2, 3])('rejects unsupported address bits for tag %i during root inference', (tag) => {
    const r = runtimeBy('_ remaining:Cell = Fallback; _ address:MsgAddress tail:uint8 = Msg;');
    const wire = beginCell()
        .storeUint(tag, 2)
        .storeBit(true)
        .storeUint(1, 5)
        .storeBit(0)
        .storeUint(0, 8)
        .storeUint(0, 256)
        .storeUint(42, 8)
        .endCell();
    expect(() => r.decodeCell(wire)).toThrow(/unsupported/i);
    expect(() => r.decodeCell(wire, { rootType: 'Msg' })).toThrow(/unsupported/i);
});
