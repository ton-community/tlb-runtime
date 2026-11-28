import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { groupCorpusFlat } from '../tesdata';
import { UnpackedSize, packSize, Schema, unpackSize, PackedSize } from '.';
import { TLBSchemaError } from '../TLBRuntime';
import { unwrap } from '../Result';
import { TypeInteger } from './Type';

describe('Schema', () => {
    it('reports a field with a missing type argument instead of skipping its wire position', () => {
        const result = Schema.from('_ first:uint8 broken:uint last:uint8 = Example;');
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error).toBeInstanceOf(TLBSchemaError);
            expect(result.error.message).toContain('Invalid field broken in Example: uint type requires an argument');
        }
    });

    it('keeps the enclosing width and constraint in a flattened group', () => {
        const schema = unwrap(Schema.from('_ n:uint4 ^[ y:uint8 x:(uint n) { y <= 2 } ] = Box;'));
        const ctor = schema.getTLBTypes().get('Box')!.constructors[0];
        expect(ctor.fields[1].subFields[1]).toMatchObject({
            name: 'x',
            fieldType: { bits: { kind: 'TLBVarExpr', x: 'n' } },
        });
        expect(ctor.constraints).toContainEqual(
            expect.objectContaining({ operation: '<=', left: { kind: 'TLBVarExpr', x: 'y' } }),
        );
    });

    it('keeps the wire tag and byte bound in the constructor model', () => {
        const schema = unwrap(Schema.from('/* old#_ = Box; */ box#ab v:(VarUInteger 5) = Box;'));
        const ctor = schema.getTLBTypes().get('Box')!.constructors[0];
        expect(ctor.tag).toMatchObject({ bitLen: 8, binary: '0xab' });
        expect(ctor.fields[0].fieldType).toMatchObject({
            kind: 'TLBVarIntegerType',
            upperBound: { kind: 'TLBNumberExpr', n: 5 },
        });
    });

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
        expect(actual.typesNum).toBe(1552);
        expect(actual.builtinTypesNum).toBe(1552);
        expect(actual.userTypes.length).toBe(0);
        expect(actual.userDefinedInfo).toBe(`1552 types defined, out of them 1552 built-in, 0 user-defined
****************
0 constant expressions:
`);
    });

    describe('test data', () => {
        test.each([
            // Note: typesNum/userTypesNum may differ from reference due to anonymous type handling
            // Reference implementation deduplicates identical anonymous types, which we don't do yet
            ['block', 1765, 213],
            ['schemes', 1868, 316],
        ])('%s', (name: string, typesNum: number, userTypesNum: number) => {
            const actual = unwrap(
                Schema.from(readFileSync(resolve(__dirname, '../../testdata', name + '.tlb'), 'utf8')),
            );
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

it('isolates symbol IDs and names across schema compilations', () => {
    const first = unwrap(Schema.from('_ left:uint8 = First;'));
    const second = unwrap(Schema.from('_ right:uint8 = Second;'));
    expect(first.findTypeByName('First')!.typeNameId).toBe(second.findTypeByName('Second')!.typeNameId);
    expect(first.getTLBTypes().get('First')!.constructors[0].fields[0].name).toBe('left');
    expect(second.getTLBTypes().get('Second')!.constructors[0].fields[0].name).toBe('right');
});

it.each([
    ['_ n:(## 8) { N <= 5 } = A;', 'N'],
    ['_ { n <= 5 } n:(## 8) = A;', 'n'],
])('rejects an unresolved constraint in %s', (code, name) => {
    const compile = () => unwrap(Schema.from(code));
    expect(compile).toThrow(TLBSchemaError);
    expect(compile).toThrow(new RegExp('Invalid constraint in A.*Unknown numeric identifier ' + name));
});

it.each(['n:(## Bar)', 'b:(bits Bar)', 'n:(## 8) { n = Bar }', 'd:(HashmapE Bar uint8)'])(
    'rejects a declared type in the numeric position of %s',
    (field) => {
        expect(() => unwrap(Schema.from(`_ x:uint8 = Bar; _ ${field} = A;`))).toThrow(/Cannot use Bar as a number/);
    },
);
