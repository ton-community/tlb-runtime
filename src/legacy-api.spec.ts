import { Address, beginCell, Cell, Dictionary } from '@ton/core';

import {
    decodeCell,
    encodeCell,
    parseCell,
    ParsedCell,
    runtimeBy,
    parseTLB,
    TLBDataError,
    TLBRuntime,
    TLBSchemaError,
    unwrap,
} from './index';
import { groupCorpusFlat, TLBStd } from './tesdata';

interface Signed {
    kind: 'Signed';
    value: number;
}

describe('legacy public API', () => {
    const schema = '_ value:int32 = Signed;';
    const cell = beginCell().storeInt(-3, 32).endCell();

    it('supports existing imports and a record interface without an index signature', () => {
        const runtime = parseTLB<Signed>(schema);
        const parsed: ParsedCell = parseCell(schema, cell);
        expect(runtime).toBeInstanceOf(TLBRuntime);
        expect(runtime.parseCell(cell.toBoc().toString('base64'))).toEqual(parsed);
        expect(parsed).toEqual(decodeCell(schema, cell));
        expect(encodeCell(schema, parsed).equals(cell)).toBe(true);
        expect(runtime.encodeCell(parsed).equals(cell)).toBe(true);
        expect(unwrap(runtime.deserialize(cell)).value).toBe(-3);
        expect(runtime.types.get('Signed')).toBe(runtime.getTypes().get('Signed'));
    });

    it('round-trips every field in a TON Connect OffchainOrder', () => {
        const orderSchema = [
            'offchain_order$_ salt:uint32 market_id:uint32',
            'maker_amount:(VarUInteger 16) taker_amount:(VarUInteger 16)',
            'is_buy:Bool is_yes:Bool creator_pub_key:uint256 = OffchainOrder;',
        ].join(' ');
        const order = beginCell()
            .storeUint(1, 32)
            .storeUint(2, 32)
            .storeCoins(60000000n)
            .storeCoins(100000000n)
            .storeBit(true)
            .storeBit(false)
            .storeUint(123n, 256)
            .endCell();
        const runtime = unwrap(parseTLB(schema).changeSchema(orderSchema));
        const value = runtime.parseCell(order);
        expect(value).toEqual({
            kind: 'OffchainOrder',
            salt: 1,
            market_id: 2,
            maker_amount: 60000000n,
            taker_amount: 100000000n,
            is_buy: true,
            is_yes: false,
            creator_pub_key: 123n,
        });
        expect(runtime.encodeCell(value).equals(order)).toBe(true);
    });

    it('retains the schema error exposed by parseTLB', () => {
        expect(() => parseTLB('_')).toThrow(TLBSchemaError);
        expect(() => parseTLB('_')).toThrow('Bad Schema');
    });
});

describe('public encoding of alpha.4 records', () => {
    it.each(['', 'bool_false$0 = Bool; bool_true$1 = Bool; '])(
        'round-trips both Bool values with declarations %j',
        (prefix) => {
            const schema = prefix + '_ flag:Bool = Foo;';
            for (const flag of [false, true]) {
                const cell = beginCell().storeBit(flag).endCell();
                const record = parseCell(schema, cell);
                expect(record).toEqual({ kind: 'Foo', flag });
                expect(encodeCell(schema, record).equals(cell)).toBe(true);
                expect(encodeCell(schema, { kind: 'Foo', flag }).equals(cell)).toBe(true);
            }
        },
    );

    it.each(['Coins', '(VarUInteger 16)'])('round-trips shorthand %s', (type) => {
        const schema = `_ amount:${type} = Foo;`;
        const cell = beginCell().storeCoins(435n).endCell();
        const record = parseCell(schema, cell);
        expect(record).toEqual({ kind: 'Foo', amount: 435n });
        for (const value of [record, { kind: 'Foo', amount: 435n }, decodeCell(schema, cell)]) {
            expect(encodeCell(schema, value).equals(cell)).toBe(true);
        }
    });

    it('accepts const0 for a legacy const field and preserves explicit const0 fields', () => {
        const schema = '_ const:uint8 = Foo;';
        const cell = beginCell().storeUint(15, 8).endCell();
        const parsed = parseCell(schema, cell);
        expect(parsed).toEqual({ kind: 'Foo', const0: 15 });
        for (const record of [parsed, { kind: 'Foo', const0: 15 }]) {
            expect(encodeCell(schema, record).equals(cell)).toBe(true);
        }
        const both = '_ const:uint8 const0:uint8 = Foo;';
        const pair = beginCell().storeUint(2, 8).storeUint(3, 8).endCell();
        expect(encodeCell(both, parseCell(both, pair)).equals(pair)).toBe(true);
        expect(runtimeBy(both).encodeCell(decodeCell(both, pair)).equals(pair)).toBe(true);
        expect(() => encodeCell(schema, { kind: 'Foo', const: 15 })).toThrow();
        expect(() => encodeCell(both, { kind: 'Foo', const0: 3 })).toThrow();
    });
});

describe.each(['#< 3', '#<= 2'])('legacy bounded natural (%s)', (bound) => {
    const runtime = parseTLB(`_ x:(${bound}) = T;`);
    const options = { rootType: 'T' };

    it('round-trips the largest permitted value', () => {
        const cell = beginCell().storeUint(2, 2).endCell();
        const data = { kind: 'T', x: 2 };
        expect(runtime.decodeCell(cell, options)).toEqual(data);
        expect(runtime.encodeCell(data).equals(cell)).toBe(true);
    });

    it('rejects the unused two-bit pattern on read and write', () => {
        const cell = beginCell().storeUint(3, 2).endCell();
        expect(() => runtime.decodeCell(cell, options)).toThrow(TLBDataError);
        expect(() => runtime.encodeCell({ kind: 'T', x: 3 })).toThrow(TLBDataError);
    });
});

it('writes only the tag for constructors with implicit parameters', () => {
    const runtime = parseTLB('a$0 {n:#} = P n; b$1 {n:#} = P (n + 1);');
    expect(runtime.encodeCell({ kind: 'P_a', n: 3 }).equals(beginCell().storeBit(0).endCell())).toBe(true);
    expect(runtime.encodeCell({ kind: 'P_b', n: 3 }).equals(beginCell().storeBit(1).endCell())).toBe(true);
});

it('leaves the parent field after an implicit argument intact', () => {
    const runtime = parseTLB('a$0 {n:#} = E n; _ e:(E 3) y:uint64 = Bar;');
    const wire = beginCell().storeBit(0).storeUint(123, 64).endCell();
    const data = runtime.decodeCell(wire);
    expect(data).toEqual({ kind: 'Bar', e: { kind: 'E', n: 3 }, y: 123n });
    expect(runtime.encodeCell(data).equals(wire)).toBe(true);
});

it('round-trips renamed legacy fields with the public encoder', () => {
    const schema = '_ cells:uint8 default:uint8 public:uint8 = Foo;';
    const wire = beginCell().storeUint(0x010203, 24).endCell();
    const record = parseCell(schema, wire);
    expect(record).toEqual({ kind: 'Foo', _cells: 1, default0: 2, public0: 3 });
    expect(encodeCell(schema, record).equals(wire)).toBe(true);
});

it.each([
    ['Grams', beginCell().storeCoins(25n).endCell()],
    ['MsgAddress', beginCell().storeAddress(null).endCell()],
    [
        'MsgAddressInt',
        beginCell()
            .storeAddress(new Address(0, Buffer.alloc(32)))
            .endCell(),
    ],
    [
        '(HashmapE 8 uint8)',
        beginCell()
            .storeDict(Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Uint(8)).set(3, 7))
            .endCell(),
    ],
] as const)('supports the undeclared legacy built-in %s', (type, wire) => {
    const schema = `_ a:${type} = Foo;`;
    expect(encodeCell(schema, parseCell(schema, wire)).equals(wire)).toBe(true);
    const runtime = unwrap(TLBRuntime.from(schema));
    expect(runtime.encodeCell(runtime.decodeCell(wire)).equals(wire)).toBe(true);
});

it('keeps the binding of W.X out of the unrelated Inner constructor', () => {
    const schema = '_ v:uint8 = X; _ x:X = Inner; _ {X:Type} v:X w:Inner = W X; _ r:(W uint16) = R;';
    const runtime = parseTLB(schema);
    const wire = beginCell().storeUint(0x1234, 16).storeUint(0xab, 8).endCell();
    const expected = { kind: 'R', r: { kind: 'W', v: 0x1234, w: { kind: 'Inner', x: { kind: 'X', v: 0xab } } } };
    expect(unwrap(runtime.deserialize(wire))).toEqual(expected);
    expect(runtime.decodeCell(wire, { rootType: 'R' })).toEqual(expected);
});

it('round-trips the legacy bigint shape of explicitly declared Coins and Grams', () => {
    const schema = TLBStd.VarUInteger + TLBStd.Grams + TLBStd.Coins + '_ a:Coins = Foo;';
    const wire = beginCell().storeCoins(435n).endCell();
    const data = parseCell(schema, wire);
    expect(data).toEqual({ kind: 'Foo', a: 435n });
    expect(encodeCell(schema, data).equals(wire)).toBe(true);
});

describe.each(Object.entries(groupCorpusFlat))('legacy public helpers over %s', (_group, cases) => {
    it.each(cases)('preserves the legacy round-trip for %s', (schema, { kind }, boc) => {
        const wire = Cell.fromHex(boc);
        // This root requires an explicit argument, which the deprecated free helper cannot take.
        if (kind === 'MathExprAsCombArg') {
            expect(() => parseCell(schema, wire)).toThrow(TLBDataError);
            return;
        }
        const data = parseCell(schema, wire);
        const encoded = encodeCell(schema, data);
        if (kind === 'ParamConst_d') {
            // Both a and d are tagless. Without root arguments a matches the first field.
            expect(data).toEqual({ kind: 'ParamConst_a', n: 1 });
            expect(encoded.equals(beginCell().storeUint(1, 32).endCell())).toBe(true);
            return;
        }
        // These fixtures lose root selection or dictionary extras during legacy decoding.
        if (['HashmapAugEUser', 'ParamConst_b', 'ParamConst_c', 'ParamDifNames_c', 'ParamDifNames_d'].includes(kind)) {
            expect(encoded.equals(parseTLB(schema).encodeCell(data))).toBe(true);
        } else {
            expect(encoded.equals(wire)).toBe(true);
        }
    });
});

it.each([
    ['_ a:uint8 { a <= 3 } = Foo;', 2, 8],
    ['a$0 = Foo; a$1 = Foo;', 1, 1],
    ['_ a:uint8 a:uint8 = Foo;', 258, 16],
    ['_ b:Bar = Baz; _ a:uint8 = Foo;', 42, 8],
    ['_ x:uint8 = foo;', 42, 8],
] as const)('round-trips legacy parseCell output for %s', (schema, value, bits) => {
    const wire = beginCell().storeUint(value, bits).endCell();
    expect(encodeCell(schema, parseCell(schema, wire)).equals(wire)).toBe(true);
});

it.each([
    ['e$0 = E;', 'E', 'E'],
    [TLBStd.Maybe, '(Maybe uint8)', 'Maybe_nothing'],
])('reads only the fields of a fieldless %s constructor on a shared line', (declaration, type, kind) => {
    const schema = `_ x:uint8 = Foo; ${declaration.trim()} _ e:${type} y:uint8 = Root;`;
    const data = { kind: 'Root', e: { kind }, y: 171 };
    const prefix = () => beginCell().storeBit(0).storeUint(171, 8);
    expect(parseCell(schema, prefix().storeUint(205, 8).endCell())).toEqual(data);
    expect(encodeCell(schema, data).equals(prefix().endCell())).toBe(true);
});

it('uses the legacy VarInteger length prefix in both free helpers', () => {
    const schema = TLBStd.VarInteger + '_ v:(VarInteger 5) = A;';
    const wire = beginCell().storeVarInt(-6, 5).endCell();
    expect(encodeCell(schema, { kind: 'A', v: -6 }).equals(wire)).toBe(true);
    expect(parseCell(schema, wire)).toEqual({ kind: 'A', v: -6n });
    const current = runtimeBy(schema);
    const currentWire = beginCell().storeVarInt(-6, 3).endCell();
    expect(current.encodeCell({ kind: 'A', v: -6 }).equals(currentWire)).toBe(true);
    expect(decodeCell(schema, currentWire)).toEqual({ kind: 'A', v: -6n });
});

it('preserves alpha.4 field names and signed length prefixes through TLBRuntime.from', () => {
    const runtime = unwrap(TLBRuntime.from('_ const:uint8 = C;'));
    expect(runtime.decodeCell(beginCell().storeUint(9, 8).endCell())).toEqual({ kind: 'C', const0: 9 });
    const changed = unwrap(runtime.changeSchema(TLBStd.VarInteger + '_ v:(VarInteger 5) = A;'));
    expect(changed.decodeCell(beginCell().storeVarInt(-6, 5).endCell())).toEqual({ kind: 'A', v: -6n });
});

it('treats native cells as opaque when looking for a numeric parameter', () => {
    const child = beginCell().storeUint(9, 8).endCell();
    const wire = beginCell().storeRef(child).endCell();
    expect(parseCell('_ {type:#} c:^Cell = T type;', wire)).toEqual({ kind: 'T', c: child });
});

it('preserves the alpha.4 wire width for a variable inclusive bound', () => {
    const schema = '_ n:# x:(#<= n) = T;';
    const record = { kind: 'T', n: 5, x: 3 };
    const wire = (width: number) => beginCell().storeUint(5, 32).storeUint(3, width).endCell();
    for (const [runtime, width] of [
        [unwrap(TLBRuntime.from(schema)), 5],
        [runtimeBy(schema), 3],
    ] as const) {
        expect(runtime.decodeCell(wire(width))).toEqual(record);
        expect(runtime.encodeCell(record).equals(wire(width))).toBe(true);
    }
    expect(parseCell(schema, wire(5))).toEqual(record);
    expect(encodeCell(schema, record).equals(wire(5))).toBe(true);
});
