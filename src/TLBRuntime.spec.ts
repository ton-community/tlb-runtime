import { beginCell, Cell } from '@ton/core';

import { parseCell, encodeCell, replacer } from './parser';
import { groupCorpusFlat } from './tesdata';

describe('TLBRuntime', () => {
    describe('deserialize', () => {
        describe.each(Object.keys(groupCorpusFlat))('%s', (group) => {
            it.each(groupCorpusFlat[group])('deserialize %s', (schema, expected, boc) => {
                const actual = parseCell(schema, Cell.fromHex(boc));
                expect(JSON.stringify(actual, replacer)).toEqual(JSON.stringify(expected, replacer));
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
