import { beginCell } from '@ton/core';

import { runtimeBy } from './index';

it.each(['^[ a:uint8 ] ^[ a:uint8 ]', 'a:uint8 ^[ a:uint8 ]', '^[ ^[ a:uint8 ] ] a:uint8', '^[ uint8 ] anon1:uint8'])(
    'rejects colliding decoded keys for %s',
    (fields) => {
        expect(() => runtimeBy(`_ ${fields} = Row;`)).toThrow(
            /Duplicate decoded field .* in Row at fields.* and fields/,
        );
    },
);

it('preserves both values from anonymous reference groups', () => {
    const child = (n: number) => beginCell().storeUint(n, 8).endCell();
    const input = beginCell().storeRef(child(3)).storeRef(child(5)).endCell();
    const r = runtimeBy('_ ^[ a:uint8 ] ^[ b:uint8 ] = Row;');
    const result = r.decodeCell(input, { rootType: 'Row' });
    expect(result).toEqual({ kind: 'Row', a: 3, b: 5 });
    expect(r.encodeCell(result).equals(input)).toBe(true);
});

it('resolves parent widths, type arguments and flags inside a reference', () => {
    const r = runtimeBy(
        '_ {X:Type} n:uint4 flag:uint1 ^[ y:uint8 x:(uint n) v:X z:flag?uint8 ] = Wrap X; _ w:(Wrap uint8) = Box;',
    );
    const wire = beginCell()
        .storeUint(4, 4)
        .storeBit(1)
        .storeRef(beginCell().storeUint(2, 8).storeUint(13, 4).storeUint(3, 8).storeUint(7, 8))
        .endCell();
    const value = { kind: 'Box', w: { kind: 'Wrap', n: 4, flag: 1, y: 2, x: 13, v: 3, z: 7 } };
    expect(r.decodeCell(wire)).toEqual(value);
    expect(r.encodeCell(value).equals(wire)).toBe(true);
});

it('checks constraints inside nested flattened references', () => {
    const r = runtimeBy('_ ^[ ^[ flags:uint16 { flags <= 1 } ] ] = Box;');
    const wire = (flags: number) =>
        beginCell()
            .storeRef(beginCell().storeRef(beginCell().storeUint(flags, 16)))
            .endCell();
    expect(r.decodeCell(wire(1))).toEqual({ kind: 'Box', flags: 1 });
    expect(() => r.decodeCell(wire(99))).toThrow();
    expect(() => r.encodeCell({ kind: 'Box', flags: 99 })).toThrow();
});

it('excludes an internal group from root inference', () => {
    const r = runtimeBy('foo#deadbeef ^[ a:uint8 ] = Foo;');
    const wire = beginCell().storeUint(42, 8).endCell();
    expect(r.deserialize(wire).success).toBe(false);
    expect(r.deserialize(wire, true).success).toBe(false);
});

it('keeps the enclosing parameters inside an inline anonymous group', () => {
    const r = runtimeBy('_ {X:Type} n:uint4 g:[ a:uint8 x:(uint n) v:X ] = Wrap X; _ w:(Wrap uint8) = Box;');
    const wire = beginCell().storeUint(4, 4).storeUint(2, 8).storeUint(13, 4).storeUint(7, 8).endCell();
    const value = r.decodeCell(wire);
    expect(value).toMatchObject({ kind: 'Box', w: { n: 4, g: { a: 2, x: 13, v: 7 } } });
    expect(r.encodeCell(value).equals(wire)).toBe(true);
});
