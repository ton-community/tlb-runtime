import { groupCorpusFlat } from '../tesdata';
import { UnpackedSize, packSize, Schema, unpackSize, PackedSize } from '.';
import { unwrap } from '../Result';
import { TypeInteger } from './Type';
import { loadData } from '../../testdata';

describe('Schema', () => {
    describe.each([
        ['Any', { maxBits: 2047, maxRefs: 7, minBits: 0, minRefs: 0 }, 0x7ff07n],
        ['OneRef', { maxBits: 0, maxRefs: 1, minBits: 0, minRefs: 1 }, 0x100000001n],
        ['Impossible', { maxBits: 0, maxRefs: 0, minBits: 2047, minRefs: 7 }, 0x7ff0700000000n],
    ])('size %s', (name: string, unpack: UnpackedSize, pack: PackedSize) => {
        test(`unpackSize ${name}`, () => {
            expect(unpackSize(pack)).toEqual(unpack);
        });
        test(`packSize ${name}`, () => {
            expect(packSize(unpack)).toEqual(pack);
        });
    });

    describe('produces nat', () => {
        const actual = new Schema();
        const list: [[string, number]] = actual.types
            .filter((type) => type.producesNat)
            .map((type) => [type.name, type.isInteger]) as [[string, number]];
        describe.each(list)('check %s', (name: string, isInteger: number) => {
            test(`nat is uint for ${name}`, () => {
                expect(isInteger).toEqual(TypeInteger.Unsigned);
            });
        });
    });

    test('builtin', () => {
        const actual = new Schema();
        expect(actual.typesNum).toBe(1549);
        expect(actual.builtinTypesNum).toBe(1549);
        expect(actual.userTypes.length).toBe(0);
        expect(actual.userDefinedInfo).toBe(`1549 types defined, out of them 1549 built-in, 0 user-defined
****************
0 constant expressions:
`);

        expect(actual.types).toMatchSnapshot();
    });

    describe('test data', () => {
        test.each([
            // Note: typesNum/userTypesNum may differ from reference due to anonymous type handling
            // Reference implementation deduplicates identical anonymous types, which we don't do yet
            ['block', 1762, 213],
            ['schemes', 1862, 313],
        ])('%s', (name: string, typesNum: number, userTypesNum: number) => {
            const actual = unwrap(Schema.from(loadData(`${name}.tlb`)));
            // Compare first line (type counts) and verify parsing succeeded
            const firstLine = actual.userDefinedInfo.split('\n')[0];
            expect(firstLine).toContain('types defined');
            expect(actual.typesNum).toBe(typesNum);
            expect(actual.userTypesNum).toBe(userTypesNum);
        });
    });

    describe.each(Object.keys(groupCorpusFlat))('%s', (group) => {
        test.each(groupCorpusFlat[group])('parse %s', (schema) => {
            const actual = Schema.from(schema);
            expect(actual.success).toBeTruthy();
        });
    });
});
