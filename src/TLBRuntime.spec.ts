import { beginCell, Cell } from '@ton/core';

import { parseCell, encodeCell, replacer } from './parser';
import { unwrap } from './Result';
import { groupCorpusFlat } from './tesdata';
import { parseTLB } from './TLBRuntime';

describe('TLBRuntime', () => {
    describe('deserialize', () => {
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
