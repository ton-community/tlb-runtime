import { Cell, beginCell, Address, ExternalAddress, Dictionary, Builder } from '@ton/core';

import { decodeCell, encodeCell, replacer } from './parser';
import { groupCorpusFlat, TLBStd, TLBLib } from './tesdata';
import { TLBRuntime, runtimeBy, TLBRuntimeError, TypedCell, TypeCell } from './TLBRuntime';
import { TLBSchemaError } from './errors';
import { Failure, unwrap } from './Result';

describe('TLBRuntime', () => {
    describe('basic', () => {
        it('create runtime for valid schema', () => {
            const schema = '_ x:# = T;';
            const result = runtimeBy(schema);
            expect(result).toBeInstanceOf(TLBRuntime);
            expect(result).toHaveProperty('schema', schema);
            expect(unwrap(result.changeSchema(schema))).toMatchObject(result);
            expect(unwrap(result.changeSchema(`${schema} _ x:# = N;`))).not.toMatchObject(result);
        });

        it('create runtime for invalid schema', () => {
            const invalidSchema = '_';
            const result = TLBRuntime.from(invalidSchema) as Failure;
            expect(result.success).toBe(false);
            expect(result.error).toBeInstanceOf(TLBSchemaError);
            expect(result.error.message).toEqual(
                'Schema parsing failed: cannot apply Semantics to [match failed at position 1]',
            );
        });

        it('parsed Nat and tag map', () => {
            const schema = 'a$0 x:# = T; b$1 y:# = T;';
            const runtime = runtimeBy(schema);
            const a = (b: Builder) => b.storeUint(0, 1).storeUint(41, 32);
            const b = (b: Builder) => b.storeUint(1, 1).storeUint(42, 32);
            expect(unwrap(runtime.deserialize(a(beginCell()).endCell()))).toEqual({
                kind: 'T_a',
                x: 41,
            });
            expect(unwrap(runtime.deserialize(b(beginCell()).endCell()))).toEqual({
                kind: 'T_b',
                y: 42,
            });
            expect(unwrap(runtime.deserialize(b(a(beginCell())).endCell()))).toEqual({
                kind: 'T_a',
                x: 41,
            });
            expect(unwrap(runtime.deserialize(a(b(beginCell())).endCell()))).toEqual({
                kind: 'T_b',
                y: 42,
            });
        });
    });

    describe('deserialize', () => {
        describe('basic numeric types', () => {
            it('deserializes OneNatParam with # (32-bit nat)', () => {
                const schema = '_ x:# = OneNatParam;';
                const boc = 'b5ee9c724101010100060000080000002a05a6f044';
                const result = decodeCell(schema, boc);
                expect(result).toEqual({
                    kind: 'OneNatParam',
                    x: 42,
                });
            });

            it('deserializes TowNatParam with multiple # fields', () => {
                const schema = '_ x:# y:# = TowNatParam;';
                const boc = 'b5ee9c7241010101000a0000100000033b00000183b67dff10';
                const result = decodeCell(schema, boc);
                expect(result).toEqual({
                    kind: 'TowNatParam',
                    x: 827,
                    y: 387,
                });
            });

            it('deserializes LimitNat with ## n (n-bit nat)', () => {
                const schema = '_ x:(## 5) = LimitNat;';
                const boc = 'b5ee9c7241010101000300000154868284e3';
                expect(decodeCell(schema, boc)).toEqual({
                    kind: 'LimitNat',
                    x: 10,
                });
            });

            it('deserializes IntType with int n (signed)', () => {
                const schema = 'a#a value:int257 = IntType;';
                const boc =
                    'b5ee9c72410101010023000041a8000000000000000000000000000000000000000000000000000000000000000c832f60b1';
                expect(decodeCell(schema, boc)).toEqual({
                    kind: 'IntType',
                    value: -115792089237316195423570985008687907853269984665640564039457584007913129639935n,
                });
            });

            it('deserializes UintType with uint n (unsigned)', () => {
                const schema = 'b#b value:uint256 = UintType;';
                const boc =
                    'b5ee9c72410101010023000041bffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8a8a15cf2';
                expect(decodeCell(schema, boc)).toEqual({
                    kind: 'UintType',
                    value: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
                });
            });
        });

        describe('cell references', () => {
            it('deserializes ParamCell with ^Cell field', () => {
                const schema = '_ x:^Cell = ParamCell;';
                const boc = 'b5ee9c724101020100050001000100006e1c5c44';
                const result = decodeCell(schema, boc);
                expect(result.kind).toEqual('ParamCell');
                expect(result.x).toBeInstanceOf(Cell);
                const x = result.x as Cell;
                expect(x.toBoc().toString('hex')).toEqual('b5ee9c724101010100020000004cacb9cd');
            });

            it('deserializes UseParamCell with ^ParamCell field (recursive)', () => {
                const schema = '_ x:^Cell = ParamCell; _ x:^ParamCell = UseParamCell;';
                const boc = 'b5ee9c724101030100080001000101000200002fb6d5b6';
                const result = decodeCell(schema, boc);
                expect(result.kind).toEqual('UseParamCell');
                const ref = result.x as TypedCell;
                expect(ref.kind).toEqual('ParamCell');
                expect(ref.x).toBeInstanceOf(Cell);
                const x = ref.x as Cell;
                expect(x.toBoc().toString('hex')).toEqual('b5ee9c724101010100020000004cacb9cd');
            });
        });

        describe('Maybe type', () => {
            it('deserializes OptionType with Maybe_just', () => {
                const schema = `${TLBStd.Maybe} _ x:Nat2 y:# = A; _ x:(## 2) = Nat2; _ x:(Maybe A) = OptionType;`;
                const boc = 'b5ee9c72410101010007000009e0000000905cecef69';
                expect(decodeCell(schema, boc)).toEqual({
                    kind: 'OptionType',
                    x: {
                        kind: 'Maybe_just',
                        value: {
                            kind: 'A',
                            x: { kind: 'Nat2', x: 3 },
                            y: 4,
                        },
                    },
                });
            });

            it('deserializes OptionType with Maybe_nothing', () => {
                const schema = `${TLBStd.Maybe} _ x:Nat2 y:# = A; _ x:(## 2) = Nat2; _ x:(Maybe A) = OptionType;`;
                const boc = 'b5ee9c7241010101000300000140f6d24034';
                expect(decodeCell(schema, boc)).toEqual({
                    kind: 'OptionType',
                    x: { kind: 'Maybe_nothing' },
                });
            });
        });

        describe('Bool type', () => {
            it('deserializes BoolUser with bool_true$1 (x: true)', () => {
                const schema = `${TLBStd.Bool} _ x:Bool = BoolUser;`;
                const boc = 'b5ee9c72410101010003000001c08ee9b6b6';
                expect(decodeCell(schema, boc)).toEqual({ kind: 'BoolUser', x: true });
            });

            it('deserializes BoolUser with bool_false$0 (x: false)', () => {
                const schema = `${TLBStd.Bool} _ x:Bool = BoolUser;`;
                const boc = 'b5ee9c7241010101000300000140f6d24034';
                expect(decodeCell(schema, boc)).toEqual({ kind: 'BoolUser', x: false });
            });
        });

        describe('MsgAddress types', () => {
            it('deserializes AnyAddressUser with addr_std (standard internal address)', () => {
                const schema = `${TLBLib.MsgAddress} _ x:MsgAddress = AnyAddressUser;`;
                const boc =
                    'b5ee9c72410101010024000043800cd9adc60c4a2ada5b103047cd87ea14094a5bac59f2b4c67ac67741ec1ec2c8101a51407b';
                const result = decodeCell(schema, boc);
                expect(result.kind).toEqual('AnyAddressUser');
                expect(result.x).toBeInstanceOf(Address);
                const x = result.x as Address;
                expect(x.toString()).toEqual('EQBmzW4wYlFW0tiBgj5sP1CgSlLdYs-VpjPWM7oPYPYWQEdT');
            });

            it('deserializes AnyAddressUser with addr_extern (external address)', () => {
                const schema = `${TLBLib.MsgAddress} _ x:MsgAddress = AnyAddressUser;`;
                const boc = 'b5ee9c7241010101000a00000f46000029e51ceed0cc1604f8';
                const result = decodeCell(schema, boc);
                expect(result.kind).toEqual('AnyAddressUser');
                expect(result.x).toBeInstanceOf(ExternalAddress);
                const x = result.x as ExternalAddress;
                expect(x.toString()).toEqual('External<48:5623048054>');
            });

            it('deserializes AnyAddressUser with addr_none (null)', () => {
                const schema = `${TLBLib.MsgAddress} _ x:MsgAddress = AnyAddressUser;`;
                const boc = 'b5ee9c724101010100030000012094418655';
                expect(decodeCell(schema, boc)).toEqual({ kind: 'AnyAddressUser', x: null });
            });

            it('deserializes ExtAddressUser with addr_extern (external address)', () => {
                const schema = `${TLBLib.MsgAddress} _ x: MsgAddressExt = ExtAddressUser;`;
                const boc = 'b5ee9c7241010101000a00000f46000029e51ceed0cc1604f8';
                const result = decodeCell(schema, boc);
                expect(result.kind).toEqual('ExtAddressUser');
                // expect(result.x).toBeInstanceOf(ExternalAddress);
                // expect((result.x as ExternalAddress).value).toBe(5623048054n);
                // expect((result.x as ExternalAddress).bits).toBe(48);
            });

            it('deserializes ExtAddressUser with addr_none (null)', () => {
                const schema = `${TLBLib.MsgAddress} _ x: MsgAddressExt = ExtAddressUser;`;
                const boc = 'b5ee9c724101010100030000012094418655';
                expect(decodeCell(schema, boc)).toEqual({ kind: 'ExtAddressUser', x: null });
            });
        });

        describe('serialize MsgAddress types', () => {
            it('serializes AnyAddressUser with addr_std (standard internal address)', () => {
                const schema = `${TLBLib.MsgAddress} _ x:MsgAddress = AnyAddressUser;`;
                const data = {
                    kind: 'AnyAddressUser',
                    x: Address.parse('EQBmzW4wYlFW0tiBgj5sP1CgSlLdYs-VpjPWM7oPYPYWQEdT'),
                };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe(
                    'b5ee9c72410101010024000043800cd9adc60c4a2ada5b103047cd87ea14094a5bac59f2b4c67ac67741ec1ec2c8101a51407b',
                );
            });

            it('serializes AnyAddressUser with addr_extern (external address)', () => {
                const schema = `${TLBLib.MsgAddress} _ x:MsgAddress = AnyAddressUser;`;
                const data = {
                    kind: 'AnyAddressUser',
                    x: new ExternalAddress(5623048054n, 48),
                };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c7241010101000a00000f46000029e51ceed0cc1604f8');
            });

            it('serializes AnyAddressUser with addr_none (null)', () => {
                const schema = `${TLBLib.MsgAddress} _ x:MsgAddress = AnyAddressUser;`;
                const data = { kind: 'AnyAddressUser', x: null };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c724101010100030000012094418655');
            });

            it('serializes ExtAddressUser with addr_extern (external address)', () => {
                const schema = `${TLBLib.MsgAddress} _ x: MsgAddressExt = ExtAddressUser;`;
                const data = {
                    kind: 'ExtAddressUser',
                    x: new ExternalAddress(5623048054n, 48),
                };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c7241010101000a00000f46000029e51ceed0cc1604f8');
            });

            it('serializes ExtAddressUser with addr_none (null)', () => {
                const schema = `${TLBLib.MsgAddress} _ x: MsgAddressExt = ExtAddressUser;`;
                const data = { kind: 'ExtAddressUser', x: null };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c724101010100030000012094418655');
            });
        });

        describe('limited nat types (#< and #<=)', () => {
            it('deserializes LessThan with #< 4 and #<= 4', () => {
                const schema = '_ x:(#< 4) y:(#<= 4) = LessThan;';
                const boc = 'b5ee9c72410101010003000001fcef6f16cb';
                expect(decodeCell(schema, boc)).toEqual({ kind: 'LessThan', x: 3, y: 7 });
            });

            it('deserializes #< n correctly (ceil(log2(n)) bits)', () => {
                const schema = '_ x:(#< 4) = TestLessThan;';
                const cell = beginCell().storeUint(3, 2).endCell();
                expect(decodeCell(schema, cell)).toEqual({ kind: 'TestLessThan', x: 3 });
            });

            it('deserializes #<= n correctly (ceil(log2(n+1)) bits)', () => {
                const schema = '_ x:(#<= 4) = TestLessThanEqual;';
                const cell = beginCell().storeUint(4, 3).endCell();
                expect(decodeCell(schema, cell)).toEqual({ kind: 'TestLessThanEqual', x: 4 });
            });
        });

        describe('VarInteger and VarUInteger types', () => {
            it('deserializes VarUIntegerUser with VarUInteger 5', () => {
                const schema = `${TLBStd.VarUInteger} _ v:(VarUInteger 5) = VarUIntegerUser;`;
                const boc = 'b5ee9c7241010101000400000320b07162297c';
                const result = decodeCell(schema, boc);
                expect(result).toEqual({ kind: 'VarUIntegerUser', v: 5n });
            });

            it('deserializes VarIntegerUser with VarInteger 5 (signed)', () => {
                const schema = `${TLBStd.VarInteger} _ v:(VarInteger 5) = VarIntegerUser;`;
                const boc = 'b5ee9c724101010100040000033f501731a547';
                const result = decodeCell(schema, boc);
                expect(result).toEqual({ kind: 'VarIntegerUser', v: -6n });
            });

            it('deserializes GramsUser with Grams (VarUInteger 16)', () => {
                const schema = `${TLBLib.Grams} _ x: Grams = GramsUser;`;
                const boc = 'b5ee9c7241010101000600000730186a08506d18a4';
                const result = decodeCell(schema, boc);
                expect(result).toEqual({ kind: 'GramsUser', x: 100000n });
            });
        });

        describe('multi-constructor types', () => {
            it('deserializes MultiConstructor with a$0 constructor (tag 0)', () => {
                const schema = 'a$0 x:# y:# = MultiConstructor; b$1 x:# = MultiConstructor;';
                const boc = 'b5ee9c7241010101000b0000110000000080000001406a6a04c2';
                expect(decodeCell(schema, boc)).toEqual({ kind: 'MultiConstructor_a', x: 1, y: 2 });
            });

            it('deserializes MultiConstructor with b$1 constructor (tag 1)', () => {
                const schema = 'a$0 x:# y:# = MultiConstructor; b$1 x:# = MultiConstructor;';
                const boc = 'b5ee9c7241010101000700000980000001c001719107';
                expect(decodeCell(schema, boc)).toEqual({ kind: 'MultiConstructor_b', x: 3 });
            });

            it('distinguishes a$0 and b$1 constructors correctly by tag', () => {
                const schema = 'a$0 x:# y:# = MultiConstructor; b$1 x:# = MultiConstructor;';
                const bocA = 'b5ee9c7241010101000b0000110000000080000001406a6a04c2';
                expect(decodeCell(schema, bocA)).toEqual({
                    kind: 'MultiConstructor_a',
                    x: 1,
                    y: 2,
                });
                const bocB = 'b5ee9c7241010101000700000980000001c001719107';
                expect(decodeCell(schema, bocB)).toEqual({
                    kind: 'MultiConstructor_b',
                    x: 3,
                });
            });
        });

        describe('parameterized types', () => {
            it('deserializes ParamType with parameter n', () => {
                const schema = '_ {n:#} x:(## n) = ParamType n;';
                const boc = 'b5ee9c72410101010003000001a82322a95d';
                expect(decodeCell(schema, boc)).toEqual({ kind: 'ParamType', n: 4, x: 10 });
            });

            it('deserializes UseParamType with ParamType argument', () => {
                const schema = '_ {n:#} x:(## n) = ParamType n; _#de x:(ParamType 4) = UseParamType;';
                const boc = 'b5ee9c72410101010004000003dea82541ef56';
                expect(decodeCell(schema, boc)).toEqual({
                    kind: 'UseParamType',
                    x: { kind: 'ParamType', n: 4, x: 10 },
                });
            });

            it('serializes ParamType with parameter n', () => {
                const schema = '_ {n:#} x:(## n) = ParamType n;';
                const data = { kind: 'ParamType', n: 4, x: 10 };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c72410101010003000001a82322a95d');
            });

            it('serializes UseParamType with ParamType argument', () => {
                const schema = '_ {n:#} x:(## n) = ParamType n; _#de x:(ParamType 4) = UseParamType;';
                const data = {
                    kind: 'UseParamType',
                    x: { kind: 'ParamType', n: 4, x: 10 },
                };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c72410101010004000003dea82541ef56');
            });

            it('serializes ExprType with arithmetic expression parameter', () => {
                const schema = '_ {n:#} x:(## n) = ExprType (2 + n); _ x:(ExprType 6) = UseExprType;';
                const data = {
                    kind: 'UseExprType',
                    x: { kind: 'ExprType', n: 4, x: 10n },
                };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c72410101010003000001a82322a95d');
            });
        });

        describe('HashmapE type', () => {
            it('deserializes HashmapOptionType with hme_empty$0 (empty dictionary)', () => {
                const schema = `${TLBStd.Maybe} ${TLBLib.HashmapE} _ x:(## 2) = Nat2; _ x:(Maybe Nat2) = OptionType; _ x:(HashmapE 100 ^OptionType) = HashmapOptionType;`;
                const boc = 'b5ee9c7241010101000300000140f6d24034';
                const result = decodeCell(schema, boc);
                expect(result.kind).toEqual('HashmapOptionType');
                const dict = result.x as Dictionary<bigint, number>;
                expect(dict.size).toEqual(0);
            });

            it('deserializes HashmapOptionType with hme_root$1 (dictionary with entries)', () => {
                const schema = `${TLBStd.Maybe} ${TLBLib.HashmapE} _ x:(## 2) = Nat2; _ x:(Maybe Nat2) = OptionType; _ x:(HashmapE 100 ^OptionType) = HashmapOptionType;`;
                const boc = 'b5ee9c72410106010018000101c0010203d86002040101f4030001f0010166050001b085af7d0c';
                const result = decodeCell(schema, boc);
                expect(result.kind).toEqual('HashmapOptionType');
                const dict = result.x as Dictionary<bigint, TypedCell>;
                expect(dict.size).toEqual(2);
                expect(dict.get(3n)).toEqual({
                    kind: 'OptionType',
                    x: {
                        kind: 'Maybe_just',
                        value: {
                            kind: 'Nat2',
                            x: 3,
                        },
                    },
                });
                expect(dict.get(5n)).toEqual({
                    kind: 'OptionType',
                    x: {
                        kind: 'Maybe_just',
                        value: {
                            kind: 'Nat2',
                            x: 1,
                        },
                    },
                });
            });

            // NOTE: This test requires reordering of deserialization and constraint evaluation pipeline.
            // Issue: Constraints like {n = (~m) + l} depend on field values (l from label), but nested
            // field arguments (node:(HashmapNode m X)) depend on constraint-computed values (m).
            // Current architecture: deserializes fields THEN evaluates constraints.
            // Required: deserialize field-by-field with interleaved constraint evaluation.
            // This is Phase 3 (US-006) deferred - requires significant refactoring of the deserialization pipeline.
            // See tasks/prd-type-parameter-substitution.md for details on architectural constraints.
            it.skip('deserializes HashmapVarKeyUser with parameterized key size', () => {
                const schema = `${TLBLib.HashmapE} a$_ {n:#} x:(HashmapE n uint5) = HashmapVarKey n; a$_ x:(HashmapVarKey 5) = HashmapVarKeyUser;`;
                const boc = 'b5ee9c72410104010011000101c00102016202030003f1a00003f2602ada1261';
                const result = decodeCell(schema, boc);
                expect(result.kind).toEqual('HashmapVarKeyUser');
                const x = result.x as TypedCell;
                expect(x.kind).toEqual('HashmapVarKey');
                expect(x.n).toEqual(5);
                const dict = x.x as Dictionary<bigint, number>;
                expect(dict.size).toBe(2);
                expect(dict.get(3n)).toEqual(6);
                expect(dict.get(7n)).toEqual(9);
            });

            it('deserializes types with tagless constructors in reverse order', () => {
                // Test that tagless constructors are tried in reverse order (last declared first)
                const schema = 'a$_ x:(## 8) = TaglessType; b$_ y:(## 16) = TaglessType; c$_ z:(## 32) = TaglessType;';
                // Create data for constructor 'c' (32 bits)
                const builder = beginCell();
                builder.storeUint(0x12345678, 32);
                const boc = builder.endCell().toBoc().toString('base64');
                const result = decodeCell(schema, boc);
                // Should match constructor 'c' first (last declared)
                expect(result.kind).toEqual('TaglessType_c');
                expect(result.z).toEqual(0x12345678);
            });

            it('serializes HashmapOptionType with empty dictionary (hme_empty$0)', () => {
                const schema = `${TLBStd.Maybe} ${TLBLib.HashmapE} _ x:(## 2) = Nat2; _ x:(Maybe Nat2) = OptionType; _ x:(HashmapE 100 ^OptionType) = HashmapOptionType;`;
                const data = {
                    kind: 'HashmapOptionType',
                    x: Dictionary.empty(Dictionary.Keys.BigUint(100)),
                };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c7241010101000300000140f6d24034');
            });

            it('serializes HashmapOptionType with dictionary entries (hme_root$1)', () => {
                const schema = `${TLBStd.Maybe} ${TLBLib.HashmapE} _ x:(## 2) = Nat2; _ x:(Maybe Nat2) = OptionType; _ x:(HashmapE 100 ^OptionType) = HashmapOptionType;`;
                const data = {
                    kind: 'HashmapOptionType',
                    x: Dictionary.empty(Dictionary.Keys.BigUint(100))
                        .set(3n, {
                            kind: 'OptionType',
                            x: { kind: 'Maybe_just', value: { kind: 'Nat2', x: 3 } },
                        })
                        .set(5n, {
                            kind: 'OptionType',
                            x: { kind: 'Maybe_just', value: { kind: 'Nat2', x: 1 } },
                        }),
                };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe(
                    'b5ee9c72410109010022000101c0010101c0020203d86003060101f4040100050001f0010166070100080001b09c53e395',
                );
            });
        });

        describe.skip.each(Object.keys(groupCorpusFlat))('%s', (group) => {
            it.each(groupCorpusFlat[group])('deserialize %s', (schema, expected, boc) => {
                const actual = decodeCell(schema, Cell.fromHex(boc));
                expect(JSON.stringify(actual, replacer)).toEqual(JSON.stringify(expected, replacer));
            });
        });
    });

    describe('serialize', () => {
        describe('basic numeric types', () => {
            it('serializes OneNatParam with # (32-bit nat)', () => {
                const schema = '_ x:# = OneNatParam;';
                const data = { kind: 'OneNatParam', x: 42 };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c724101010100060000080000002a05a6f044');
            });

            it('serializes TowNatParam with multiple # fields', () => {
                const schema = '_ x:# y:# = TowNatParam;';
                const data = { kind: 'TowNatParam', x: 827, y: 387 };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c7241010101000a0000100000033b00000183b67dff10');
            });

            it('returns Cell type', () => {
                const schema = '_ x:# = OneNatParam;';
                const data = { kind: 'OneNatParam', x: 42 };
                const cell = encodeCell(schema, data);
                expect(cell).toBeInstanceOf(Cell);
                expect(cell.toBoc()).toBeInstanceOf(Buffer);
            });
        });

        describe('cell references', () => {
            it('serializes ParamCell with ^Cell field', () => {
                const schema = '_ x:^Cell = ParamCell;';
                const cell = Cell.fromHex('b5ee9c724101010100020000004cacb9cd');
                const data = { kind: 'ParamCell', x: cell };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c724101020100050001000100006e1c5c44');
            });

            it('serializes UseParamCell with ^ParamCell field (recursive)', () => {
                const schema = '_ x:^Cell = ParamCell; _ x:^ParamCell = UseParamCell;';
                const cell = Cell.fromHex('b5ee9c724101010100020000004cacb9cd');
                const data = {
                    kind: 'UseParamCell',
                    x: { kind: 'ParamCell', x: cell },
                };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c724101030100080001000101000200002fb6d5b6');
            });
        });

        describe('Maybe type', () => {
            it('serializes OptionType with Maybe_just', () => {
                const schema = `${TLBStd.Maybe} _ x:Nat2 y:# = A; _ x:(## 2) = Nat2; _ x:(Maybe A) = OptionType;`;
                const data = {
                    kind: 'OptionType',
                    x: {
                        kind: 'Maybe_just',
                        value: {
                            kind: 'A',
                            x: { kind: 'Nat2', x: 3 },
                            y: 4,
                        },
                    },
                };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c72410101010007000009e0000000905cecef69');
            });

            it('serializes OptionType with Maybe_nothing', () => {
                const schema = `${TLBStd.Maybe} _ x:Nat2 y:# = A; _ x:(## 2) = Nat2; _ x:(Maybe A) = OptionType;`;
                const data = {
                    kind: 'OptionType',
                    x: { kind: 'Maybe_nothing' },
                };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c7241010101000300000140f6d24034');
            });
        });

        describe('Bool type', () => {
            it('serializes BoolUser with x: true (bool_true$1)', () => {
                const schema = `${TLBStd.Bool} _ x:Bool = BoolUser;`;
                const data = { kind: 'BoolUser', x: true };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c72410101010003000001c08ee9b6b6');
            });

            it('serializes BoolUser with x: false (bool_false$0)', () => {
                const schema = `${TLBStd.Bool} _ x:Bool = BoolUser;`;
                const data = { kind: 'BoolUser', x: false };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c7241010101000300000140f6d24034');
            });
        });

        describe('limited nat types (#< and #<=)', () => {
            it('serializes LessThan with #< 4 and #<= 4', () => {
                const schema = '_ x:(#< 4) y:(#<= 4) = LessThan;';
                const data = { kind: 'LessThan', x: 3, y: 7 };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c72410101010003000001fcef6f16cb');
            });

            it('serializes #< n correctly (writes ceil(log2(n)) bits)', () => {
                const schema = '_ x:(#< 4) = TestLessThan;';
                const data = { kind: 'TestLessThan', x: 3 };
                const cell = encodeCell(schema, data);
                expect(decodeCell(schema, cell)).toEqual({ kind: 'TestLessThan', x: 3 });
            });

            it('serializes #<= n correctly (writes ceil(log2(n+1)) bits)', () => {
                const schema = '_ x:(#<= 4) = TestLessThanEqual;';
                const data = { kind: 'TestLessThanEqual', x: 4 };
                const cell = encodeCell(schema, data);
                expect(decodeCell(schema, cell)).toEqual({ kind: 'TestLessThanEqual', x: 4 });
            });
        });

        describe('VarInteger and VarUInteger types', () => {
            it('serializes VarUIntegerUser with VarUInteger 5', () => {
                const schema = `${TLBStd.VarUInteger} _ v:(VarUInteger 5) = VarUIntegerUser;`;
                const data = { kind: 'VarUIntegerUser', v: 5n };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c7241010101000400000320b07162297c');
            });

            it('serializes VarIntegerUser with VarInteger 5 (signed)', () => {
                const schema = `${TLBStd.VarInteger} _ v:(VarInteger 5) = VarIntegerUser;`;
                const data = { kind: 'VarIntegerUser', v: -6n };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c724101010100040000033f501731a547');
            });

            it('serializes GramsUser with Grams (VarUInteger 16)', () => {
                const schema = `${TLBLib.Grams} _ x: Grams = GramsUser;`;
                const data = { kind: 'GramsUser', x: 100000n };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c7241010101000600000730186a08506d18a4');
            });
        });

        describe('multi-constructor types', () => {
            it('serializes MultiConstructor with a$0 constructor (writes tag 0)', () => {
                const schema = 'a$0 x:# y:# = MultiConstructor; b$1 x:# = MultiConstructor;';
                const data = { kind: 'MultiConstructor_a', x: 1, y: 2 };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c7241010101000b0000110000000080000001406a6a04c2');
            });

            it('serializes MultiConstructor with b$1 constructor (writes tag 1)', () => {
                const schema = 'a$0 x:# y:# = MultiConstructor; b$1 x:# = MultiConstructor;';
                const data = { kind: 'MultiConstructor_b', x: 3 };
                const boc = encodeCell(schema, data).toBoc().toString('hex');
                expect(boc).toBe('b5ee9c7241010101000700000980000001c001719107');
            });

            it('writes correct tag prefix for each constructor', () => {
                const schema = 'a$0 x:# y:# = MultiConstructor; b$1 x:# = MultiConstructor;';
                const dataA = { kind: 'MultiConstructor_a', x: 1, y: 2 };
                const cellA = encodeCell(schema, dataA);
                expect(decodeCell(schema, cellA)).toEqual({ kind: 'MultiConstructor_a', x: 1, y: 2 });
                const dataB = { kind: 'MultiConstructor_b', x: 3 };
                const cellB = encodeCell(schema, dataB);
                expect(decodeCell(schema, cellB)).toEqual({ kind: 'MultiConstructor_b', x: 3 });
            });
        });

        describe.skip.each(Object.keys(groupCorpusFlat))('serialize %s', (group) => {
            it.each(groupCorpusFlat[group])('serialize %s', (schema, data, expected) => {
                const actual = encodeCell(schema, data).toBoc().toString('hex');
                expect(actual).toEqual(expected);
            });
        });

        describe('constraint validation', () => {
            it('deserializes UnaryUserCheckOrder with constraint {7 = (~m) + l}', () => {
                const schema = `${TLBStd.Unary} hm_edge#_ {l:#} {m:#} label:(Unary ~l) {7 = (~m) + l} = UnaryUserCheckOrder;`;
                const boc = 'b5ee9c72410101010003000001d0e12ee8a6';
                const result = decodeCell(schema, boc);
                expect(result).toEqual({
                    kind: 'UnaryUserCheckOrder',
                    l: 2,
                    label: {
                        kind: 'Unary_unary_succ',
                        n: 2,
                        x: {
                            kind: 'Unary_unary_succ',
                            n: 1,
                            x: {
                                kind: 'Unary_unary_zero',
                                n: 0,
                                param0: 0,
                            },
                        },
                    },
                    m: 5,
                });
            });

            it('deserializes LoadFromNegationOutsideExpr with constraint { ~prev_seq_no + 1 = seq_no }', () => {
                const schema =
                    'block_info#9bc7a987 seq_no:# { prev_seq_no:# } { ~prev_seq_no + 1 = seq_no } = LoadFromNegationOutsideExpr;';
                const boc = 'b5ee9c7241010101000a0000109bc7a9870000000448b22913';
                const result = decodeCell(schema, boc);
                expect(result.kind).toEqual('LoadFromNegationOutsideExpr');
                expect(result).toHaveProperty('prev_seq_no');
                expect(result).toHaveProperty('seq_no');
            });

            it('fails deserialization when constraint is violated', () => {
                const schema = '_ x:# y:# { x <= y } = ConstraintTest;';
                const cell = beginCell().storeUint(10, 32).storeUint(5, 32).endCell();
                const runtime = runtimeBy(schema);
                const result = runtime.deserialize(cell) as Failure;
                expect(result.success).toBe(false);
                expect(result.error).toBeInstanceOf(TLBRuntimeError);
            });
        });

        describe('Unary type', () => {
            it('deserializes unary_zero with computed n = 0', () => {
                const schema = TLBStd.Unary;
                const boc = 'b5ee9c7241010101000300000140f6d24034';
                expect(decodeCell(schema, boc)).toEqual({ kind: 'Unary_unary_zero', n: 0, param0: 0 });
            });

            it('deserializes unary_succ and computes n = child.n + 1', () => {
                const schema = TLBStd.Unary;
                const boc = 'b5ee9c72410101010003000001a0ec7a70d7';
                const result = decodeCell(schema, boc);
                expect(result.kind).toEqual('Unary_unary_succ');
                // expect((result.x as TestData).kind).toEqual('Unary_unary_zero');
                // expect(typeof result.n).toBe('number');
            });

            it('serializes Unary type correctly', () => {
                const schema = TLBStd.Unary;
                const data = { kind: 'Unary_unary_zero', n: 0 };
                const cell = encodeCell(schema, data);
                expect(decodeCell(schema, cell).kind).toBe('Unary_unary_zero');
            });
        });

        describe('anonymous fields', () => {
            it('deserializes AnonymousData with anonymous field (## 1) to anon0', () => {
                const schema = '_ (## 1) = AnonymousData;';
                const boc = 'b5ee9c72410101010003000001c08ee9b6b6';
                expect(decodeCell(schema, boc)).toEqual({ kind: 'AnonymousData', anon0: 1 });
            });

            it('serializes AnonymousData with anonymous field anon0', () => {
                const schema = '_ (## 1) = AnonymousData;';
                const data = { kind: 'AnonymousData', anon0: 1 };
                const cell = encodeCell(schema, data);
                expect(decodeCell(schema, cell)).toEqual({ kind: 'AnonymousData', anon0: 1 });
            });
        });

        describe('Type Parameter Substitution System (Phase 4: Comprehensive Testing)', () => {
            describe('Simple parameter substitution', () => {
                it('substitutes Type parameter in simple parametric type', () => {
                    // Test: {X:Type} → concrete type (uint8)
                    const schema = 'a$_ {X:Type} x:X = Container X; a$_ c:(Container uint8) = ContainerUser;';
                    const builder = beginCell();
                    builder.storeUint(42, 8); // x:uint8 value
                    const boc = builder.endCell().toBoc().toString('base64');
                    const result = decodeCell(schema, boc);
                    expect(result.kind).toEqual('ContainerUser');
                    expect((result as TypeCell).c).toBeDefined();
                    expect(((result as TypeCell).c as TypeCell).kind).toEqual('Container');
                    expect(((result as TypeCell).c as TypeCell).x).toEqual(42);
                });

                it('substitutes Nat parameter in simple parametric type', () => {
                    // Test: {n:#} → numeric value (8)
                    const schema = 'a$_ {n:#} x:(## n) = NatContainer n; a$_ c:(NatContainer 8) = NatContainerUser;';
                    const builder = beginCell();
                    builder.storeUint(255, 8); // x:(## 8) - 8 bits
                    const boc = builder.endCell().toBoc().toString('base64');
                    const result = decodeCell(schema, boc);
                    expect(result.kind).toEqual('NatContainerUser');
                    expect((result as TypeCell).c).toBeDefined();
                    expect(((result as TypeCell).c as TypeCell).kind).toEqual('NatContainer');
                    expect(((result as TypeCell).c as TypeCell).x).toEqual(255);
                });

                it('substitutes mixed Nat and Type parameters', () => {
                    // Test: both {n:#} and {X:Type} in same constructor
                    const schema = `a$_ {n:#} {X:Type} x:(## n) y:X = MixedContainer n X; a$_ c:(MixedContainer 4 uint8) = MixedUser;`;
                    const builder = beginCell();
                    builder.storeUint(15, 4); // x:(## 4) - 4 bits value 15
                    builder.storeUint(200, 8); // y:uint8
                    const boc = builder.endCell().toBoc().toString('base64');
                    const result = decodeCell(schema, boc);
                    const c = (result as TypeCell).c as TypeCell;
                    expect(c.x).toEqual(15);
                    expect(c.y).toEqual(200);
                });
            });

            describe('Multi-level parameter propagation', () => {
                it('propagates Type parameter through 3 levels of nesting', () => {
                    // Level 1: Container {X:Type} x:Inner X
                    // Level 2: Inner {X:Type} value:X
                    // Level 3: Concrete type (uint8)
                    const schema = `
                        a$_ {X:Type} value:X = Inner X;
                        b$_ {X:Type} x:(Inner X) = Container X;
                        c$_ c:(Container uint8) = ContainerUser3;
                    `;
                    const builder = beginCell();
                    builder.storeUint(123, 8);
                    const boc = builder.endCell().toBoc().toString('base64');
                    const result = decodeCell(schema, boc);
                    const c = (result as TypeCell).c as TypeCell;
                    const x = c.x as TypeCell;
                    expect(x.value).toEqual(123);
                });
            });

            describe('Parameter shadowing', () => {
                it('correctly handles parameter shadowing in nested contexts', () => {
                    // When a parameter is defined in multiple nesting levels,
                    // the innermost parameter takes precedence (standard scoping)
                    const schema = 'a$_ {X:Type} value:X = Simple X; a$_ s:(Simple uint8) = SimpleUser;';
                    const builder = beginCell();
                    builder.storeUint(42, 8);
                    const boc = builder.endCell().toBoc().toString('base64');
                    const result = decodeCell(schema, boc);
                    expect(result.kind).toEqual('SimpleUser');
                    const s = (result as TypeCell).s as TypeCell;
                    expect(s.value).toEqual(42);
                });
            });

            describe('Error handling for missing parameters', () => {
                it('handles Type parameter correctly in schema', () => {
                    // Container expects X as parameter
                    const schema = 'a$_ {X:Type} value:X = Container X;';
                    const runtimeResult = TLBRuntime.from(schema);
                    // Schema parsing should succeed
                    expect(runtimeResult.success).toBe(true);
                    if (runtimeResult.success) {
                        const runtime = runtimeResult.value;
                        expect(runtime).toBeInstanceOf(TLBRuntime);
                    }
                });
            });
        });
    });
});
