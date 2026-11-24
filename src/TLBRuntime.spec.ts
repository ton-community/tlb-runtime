import { beginCell, Cell } from '@ton/core';

import { parseCell, encodeCell, replacer } from './parser';
import { unwrap } from './Result';
import { groupCorpusFlat } from './tesdata';
import { parseTLB } from './TLBRuntime';

describe('TLBRuntime', () => {
    describe('deserialize', () => {
        it.each([
            { fields: 'q:uint8', bits: 8, payload: 7, group: 7, flat: { q: 7 } },
            { fields: 'q:uint8 z:uint8', bits: 16, payload: 0x0709, group: { q: 7, z: 9 }, flat: { q: 7, z: 9 } },
        ])(
            'preserves the historical shape of an anonymous group ($fields)',
            ({ fields, bits, payload, group, flat }) => {
                const schema = `_ ^[ ${fields} ] suffix:uint8 = Group;`;
                const child = beginCell().storeUint(payload, bits).endCell();
                const cell = beginCell().storeRef(child).storeUint(5, 8).endCell();
                const data = { kind: 'Group', '': group, suffix: 5 };

                expect(parseCell(schema, cell)).toEqual(data);
                expect(encodeCell(schema, data).equals(cell)).toBe(true);
                expect(encodeCell(schema, { kind: 'Group', ...flat, suffix: 5 }).equals(cell)).toBe(true);
            },
        );

        it('requires complete anonymous group references in a fallback', () => {
            const schema =
                'first$_ flag:uint1 ^[ left:uint4 ] ^[ right:uint4 ] = First; ' +
                'last$0 left:^Cell right:^Cell { 1 = 0 } = Last;';
            const left = beginCell().storeUint(12, 4).endCell();
            const right = beginCell().storeUint(7, 4).endCell();
            const incomplete = beginCell().storeUint(7, 4).storeRef(Cell.EMPTY).endCell();
            const makeCell = (ref: Cell) => beginCell().storeBit(false).storeRef(left).storeRef(ref).endCell();

            expect(parseCell(schema, makeCell(right))).toEqual({ kind: 'First', flag: 0, left: 12, right: 7 });
            expect(() => parseCell(schema, makeCell(incomplete))).toThrow();
        });

        it('resolves a generic cell type inside a reference', () => {
            const schema = '_ {X:Type} v:^X = Box X; _ box:(Box Cell) suffix:uint8 = BoxUser;';
            const leaf = beginCell().storeUint(11, 4).endCell();
            const payload = beginCell().storeUint(21, 5).storeRef(leaf).endCell();
            const expected = beginCell().storeRef(payload).storeUint(166, 8).endCell();
            const data = { kind: 'BoxUser', box: { kind: 'Box', v: payload }, suffix: 166 };

            expect(parseCell(schema, expected)).toEqual(data);
            expect(encodeCell(schema, data).equals(expected)).toBe(true);
        });

        it('re-encodes a generic scalar reference and the following field unchanged', () => {
            const schema = '_ {X:Type} v:^X = Box X; _ box:(Box uint8) suffix:uint8 = BoxUser;';
            const payload = beginCell().storeUint(13, 8).endCell();
            const expected = beginCell().storeRef(payload).storeUint(166, 8).endCell();
            const data = parseCell(schema, expected);

            expect(data).toEqual({ kind: 'BoxUser', box: { kind: 'Box', v: 13 }, suffix: 166 });
            expect(encodeCell(schema, data).hash()).toEqual(expected.hash());
        });

        it('computes a nested parameter in its own scope', () => {
            const schema =
                'make$0 seq:# { previous:# } { ~previous + 1 = seq } = Inner; _ previous:# child:Inner = Outer;';
            const cell = beginCell().storeUint(2, 32).storeBit(false).storeUint(10, 32).endCell();

            expect(parseCell(schema, cell)).toEqual({
                kind: 'Outer',
                previous: 2,
                child: { kind: 'Inner', previous: 9, seq: 10 },
            });
        });

        it.each([false, true])('resolves numeric arguments in the caller scope (referenced: %s)', (referenced) => {
            const schema =
                '_ {a:#} {bb:#} x:(## a) y:(## bb) = Pair a bb; ' +
                `_ a:(## 3) pair:${referenced ? '^' : ''}(Pair 2 a) suffix:uint8 = Envelope;`;
            const pair = beginCell().storeUint(3, 2).storeUint(17, 5).endCell();
            const envelope = beginCell().storeUint(5, 3);
            if (referenced) {
                envelope.storeRef(pair);
            } else {
                envelope.storeSlice(pair.beginParse());
            }
            const cell = envelope.storeUint(37, 8).endCell();
            const data = { kind: 'Envelope', a: 5, pair: { kind: 'Pair', a: 2, bb: 5, x: 3, y: 17 }, suffix: 37 };

            expect(parseCell(schema, cell)).toEqual(data);
            expect(encodeCell(schema, data).equals(cell)).toBe(true);
        });

        it.each([false, true])(
            'checks all numeric constructor arguments in the caller scope (referenced: %s)',
            (referenced) => {
                const schema =
                    'wrong$0 {a:#} x:(## a) = Choice a 2; right$1 {a:#} x:(## a) = Choice a 5; ' +
                    `_ a:(## 3) child:${referenced ? '^' : ''}(Choice 2 a) suffix:uint8 = Envelope;`;
                const makeCell = (right: boolean) => {
                    const choice = beginCell().storeBit(right).storeUint(3, 2).endCell();
                    const envelope = beginCell().storeUint(5, 3);
                    if (referenced) {
                        envelope.storeRef(choice);
                    } else {
                        envelope.storeSlice(choice.beginParse());
                    }
                    return envelope.storeUint(37, 8).endCell();
                };
                const expected = makeCell(true);
                const data = { kind: 'Envelope', a: 5, child: { kind: 'Choice_right', a: 2, x: 3 }, suffix: 37 };
                const runtime = parseTLB(schema);

                expect(parseCell(schema, expected)).toEqual(data);
                expect(encodeCell(schema, data).hash()).toEqual(expected.hash());
                expect(() => unwrap(runtime.deserializeByTypeName('Envelope', makeCell(false).beginParse()))).toThrow();
            },
        );

        it('keeps the read error for a truncated root even if a shorter type shares its tag', () => {
            const schema =
                'plain$_ value:uint16 = Plain; short#12 value:uint8 = Short; ' +
                'tiny#11 value:uint8 = Tiny; wide#12 value:uint16 = Wide;';
            const truncated = beginCell().storeUint(0x12, 8).storeUint(7, 8).endCell();
            const wide = beginCell().storeUint(0x12, 8).storeUint(0x1234, 16).endCell();
            const tiny = beginCell().storeUint(0x11, 8).storeUint(7, 8).endCell();

            expect(() => parseCell(schema, truncated)).toThrow();
            expect(parseCell(schema, wide)).toEqual({ kind: 'Wide', value: 0x1234 });
            expect(parseCell(schema, tiny)).toEqual({ kind: 'Tiny', value: 7 });
        });

        it('keeps the read error for a missing root reference even if a type without a tag fits', () => {
            const schema = 'plain$_ value:uint9 = Plain; root$0 value:uint8 ref:^Cell = Root;';
            const truncated = beginCell().storeBit(false).storeUint(7, 8).endCell();

            expect(() => parseCell(schema, truncated)).toThrow('No more references available for field ref');
        });

        it.each([
            { tag: '$0', width: 8 },
            { tag: '$_', width: 9 },
        ])('tries a complete alternative ($tag) after a root constraint fails', ({ tag, width }) => {
            const schema = `first${tag} value:uint${width} ref:^Cell = First; last$0 value:uint8 ref:^Cell { value > 9 } = Last;`;
            const ref = beginCell().storeUint(12, 4).endCell();
            const cell = beginCell().storeBit(false).storeUint(7, 8).storeRef(ref).endCell();
            const withExtraBit = beginCell().storeSlice(cell.beginParse()).storeBit(true).endCell();
            const withExtraRef = beginCell().storeSlice(cell.beginParse()).storeRef(beginCell().endCell()).endCell();

            expect(parseCell(schema, cell)).toEqual({ kind: 'First', value: 7, ref });
            expect(() => parseCell(schema, withExtraBit)).toThrow();
            expect(() => parseCell(schema, withExtraRef)).toThrow();
        });

        it('requires complete nested typed references in the alternative', () => {
            const schema =
                'leaf$_ value:uint4 = Leaf; branch$_ leaf:^Leaf = Branch; ' +
                'first$_ value:uint9 ref:^Branch = First; last$0 value:uint8 ref:^Cell { value > 9 } = Last;';
            const makeCell = (leaf: Cell) =>
                beginCell().storeBit(false).storeUint(7, 8).storeRef(beginCell().storeRef(leaf).endCell()).endCell();
            const leaf = beginCell().storeUint(12, 4).endCell();
            const withExtraBit = beginCell().storeUint(12, 4).storeBit(true).endCell();
            const withExtraRef = beginCell().storeUint(12, 4).storeRef(Cell.EMPTY).endCell();

            expect(parseCell(schema, makeCell(leaf))).toEqual({
                kind: 'First',
                value: 7,
                ref: { kind: 'Branch', leaf: { kind: 'Leaf', value: 12 } },
            });
            expect(() => parseCell(schema, makeCell(withExtraBit))).toThrow();
            expect(() => parseCell(schema, makeCell(withExtraRef))).toThrow();
        });

        it('requires complete typed references in the root before trying a fallback', () => {
            const schema =
                'leaf$_ value:uint4 = Leaf; first$_ value:uint9 ref:^Cell = First; ' +
                'last$0 value:uint8 ref:^Leaf { value > 9 } = Last;';
            const makeCell = (leaf: Cell) => beginCell().storeBit(false).storeUint(7, 8).storeRef(leaf).endCell();
            const leaf = beginCell().storeUint(12, 4).endCell();
            const withExtraBit = beginCell().storeUint(12, 4).storeBit(true).endCell();

            expect(parseCell(schema, makeCell(leaf))).toEqual({ kind: 'First', value: 7, ref: leaf });
            expect(() => parseCell(schema, makeCell(withExtraBit))).toThrow();
        });

        describe.each(Object.keys(groupCorpusFlat))('%s', (group) => {
            it.each(groupCorpusFlat[group])('deserialize %s', (schema, expected, boc) => {
                const actual = parseCell(schema, Cell.fromHex(boc));
                expect(JSON.parse(JSON.stringify(actual, replacer))).toEqual(
                    JSON.parse(JSON.stringify(expected, replacer)),
                );
            });
        });
    });

    describe('serialize', () => {
        it('serializes a referenced TVM stack before a following field', () => {
            const schema = '_ values:^VmStack suffix:uint8 = Frame;';
            const stack = beginCell()
                .storeUint(1, 24)
                .storeRef(beginCell().endCell())
                .storeUint(1, 8)
                .storeInt(7, 64)
                .endCell();
            const expected = beginCell().storeRef(stack).storeUint(5, 8).endCell();
            const data = { kind: 'Frame', values: [{ type: 'int', value: 7n }], suffix: 5 };

            expect(encodeCell(schema, data).equals(expected)).toBe(true);
        });

        it('round-trips a negative signed integer', () => {
            const schema = '_ value:int32 = Signed;';
            const cell = beginCell().storeInt(-3, 32).endCell();
            expect(encodeCell(schema, parseCell(schema, cell)).equals(cell)).toBe(true);
        });

        it.each([
            { n: 4, value: 7 },
            { n: 32, value: 0 },
        ])('rejects an unbound implicit root width of $n bits', ({ n, value }) => {
            const schema = '_ {n:#} value:(## n) = Root n;';

            expect(() => encodeCell(schema, { kind: 'Root', n, value })).toThrow('Variable n is not defined');
        });

        it('encodes a root with an unused implicit parameter', () => {
            const schema = '_ {n:#} value:uint8 = Root n;';
            const cell = beginCell().storeUint(7, 8).endCell();

            expect(encodeCell(schema, { kind: 'Root', n: 4, value: 7 }).equals(cell)).toBe(true);
        });

        it('uses the declared width for a nested numeric argument', () => {
            const schema = '_ {n:#} datum:(## n) = Nested n; _ n:(## 3) child:(Nested 4) = Envelope;';
            const data = { kind: 'Envelope', n: 2, child: { kind: 'Nested', datum: 3 } };
            const expected = beginCell().storeUint(2, 3).storeUint(3, 4).endCell();

            expect(encodeCell(schema, data).equals(expected)).toBe(true);
            expect(parseCell(schema, expected)).toEqual({
                ...data,
                child: { ...data.child, n: 4 },
            });
            expect(() => encodeCell(schema, { ...data, child: { ...data.child, n: 2 } })).toThrow(
                'Parameter n does not match the schema',
            );
        });

        it('rejects a constructor with a different numeric argument', () => {
            const schema = 'a$0 value:uint8 = Choice 1; b$1 value:uint8 = Choice 2; _ chosen:(Choice 1) = Outer;';
            const expected = beginCell().storeBit(false).storeUint(7, 8).endCell();

            expect(encodeCell(schema, { kind: 'Outer', chosen: { kind: 'Choice_a', value: 7 } }).equals(expected)).toBe(
                true,
            );
            expect(() => encodeCell(schema, { kind: 'Outer', chosen: { kind: 'Choice_b', value: 7 } })).toThrow(
                'Type argument does not match constructor Choice_b',
            );
        });

        it('serializes raw cell references with a following field', () => {
            const schema = '_ marker:uint4 x:^Cell suffix:uint8 other:^Cell = RefRaw;';
            const leaf = beginCell().storeUint(0b1011, 4).endCell();
            const payload = beginCell().storeUint(21, 5).storeRef(leaf).endCell();
            const other = beginCell().storeUint(22, 5).endCell();
            const expected = beginCell().storeUint(6, 4).storeRef(payload).storeUint(166, 8).storeRef(other).endCell();

            const actual = encodeCell(schema, { kind: 'RefRaw', marker: 6, x: payload, suffix: 166, other });

            expect(actual.hash().toString('hex')).toBe(expected.hash().toString('hex'));
        });

        it('serializes references to typed cells with a following field', () => {
            const schema = '_ value:uint8 extra:^Cell = Item; _ marker:uint4 item:^Item suffix:uint8 = RefTyped;';
            const leaf = beginCell().storeUint(0b1011, 4).endCell();
            const item = beginCell().storeUint(99, 8).storeRef(leaf).endCell();
            const expected = beginCell().storeUint(6, 4).storeRef(item).storeUint(166, 8).endCell();

            const actual = encodeCell(schema, {
                kind: 'RefTyped',
                marker: 6,
                item: { kind: 'Item', value: 99, extra: leaf },
                suffix: 166,
            });

            expect(actual.hash().toString('hex')).toBe(expected.hash().toString('hex'));
        });

        describe.each(Object.keys(groupCorpusFlat))('serialize %s', (group) => {
            it.each(groupCorpusFlat[group])('serialize %s', (schema, data, expected) => {
                const actual = encodeCell(schema, data).toBoc().toString('hex');
                expect(actual).toEqual(expected);
            });
        });
    });
});
