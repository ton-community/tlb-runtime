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
        it('round-trips a negative signed integer', () => {
            const schema = '_ value:int32 = Signed;';
            const cell = beginCell().storeInt(-3, 32).endCell();
            expect(encodeCell(schema, parseCell(schema, cell)).equals(cell)).toBe(true);
        });

        describe.each(Object.keys(groupCorpusFlat))('serialize %s', (group) => {
            it.each(groupCorpusFlat[group])('serialize %s', (schema, data, expected) => {
                const actual = encodeCell(schema, data).toBoc().toString('hex');
                expect(actual).toEqual(expected);
            });
        });
    });
});
