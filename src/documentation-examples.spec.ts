import { Address, beginCell, BitString, Cell, Dictionary, serializeTupleItem, TupleItem } from '@ton/core';

import { loadData } from '../testdata';
import { TLBRuntime } from './TLBRuntime';
import { unwrap } from './Result';
import { TLBHmLabel, TLBLib, TLBStd, TLBTVMReflection } from './tesdata';

// Wire layouts from the simple, complex and TEP examples linked by the TL-B overview.
const declarations = loadData('block.tlb')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim());
function definitions(names: RegExp) {
    return declarations
        .filter((line) => names.test(line))
        .map((line) => line + ';')
        .join('\n');
}

function check(schema: string, cell: Cell, rootType = 'Example') {
    const runtime = unwrap(TLBRuntime.from(schema, { autoText: false }));
    const data = runtime.decodeCell(cell, { rootType });
    expect(runtime.encodeCell(data).toBoc()).toEqual(cell.toBoc());
    return data;
}

describe('TON documentation examples', () => {
    it('keeps a referenced anonymous type inside Maybe and the field after it', () => {
        const schema = TLBStd.Maybe + '_ option:(Maybe ^[ x:uint8 ]) tail:uint8 = Example;';
        const cell = beginCell().storeBit(1).storeRef(beginCell().storeUint(42, 8).endCell()).storeUint(9, 8).endCell();
        expect(check(schema, cell)).toMatchObject({ option: { kind: 'Maybe_just', value: { x: 42 } }, tail: 9 });
    });

    it('Both stores its two values in order', () => {
        const s = 'pair$_ {X:Type} {Y:Type} first:X second:Y = Both X Y; _ pair:(Both uint5 int8) = Example;';
        expect(check(s, beginCell().storeUint(21, 5).storeInt(-7, 8).endCell()).pair).toEqual({
            kind: 'Both',
            first: 21,
            second: -7,
        });
    });

    it.each([16, 32])('VarUInteger %i stores 27583 in two bytes', (n) => {
        const cell = beginCell()
            .storeUint(2, Math.ceil(Math.log2(n)))
            .storeUint(27583, 16)
            .endCell();
        expect(check(TLBStd.VarUInteger + ` _ v:(VarUInteger ${n}) = Example;`, cell).v).toBe(27583n);
    });

    it.each([0, 1, 2, 3])('VmTuple of length %i', (n) => {
        const items: TupleItem[] = [
            { type: 'int', value: 44n },
            { type: 'cell', cell: beginCell().storeUint(0xb5bd3eb0, 40).endCell() },
            { type: 'int', value: -1n },
        ];
        const builder = beginCell();
        serializeTupleItem({ type: 'tuple', items: items.slice(0, n) }, builder);
        check(TLBTVMReflection, builder.endCell(), 'VmStackValue');
    });

    it('Unary 110 computes the result parameter 2', () => {
        const schema = TLBStd.Unary + '_ {n:#} value:(Unary ~n) = Example;';
        expect(check(schema, beginCell().storeUint(6, 3).endCell()).n).toBe(2);
    });

    it.each([false, true])('HmLabel repeated bit %s', (bit) => {
        const schema = TLBHmLabel + '_ {l:#} label:(HmLabel ~l 8) = Example;';
        const cell = beginCell().storeUint(3, 2).storeBit(bit).storeUint(6, 4).endCell();
        expect(check(schema, cell)).toMatchObject({ l: 6, label: { kind: 'HmLabel_hml_same', v: bit, n: 6, m: 8 } });
    });

    const label = () => beginCell().storeUint(0, 2); // hml_short with zero label length
    it('decodes the illustrated HashmapE 8 uint16 and writes the canonical dictionary', () => {
        const bits = (s: string) => beginCell().storeUint(BigInt('0b' + s), s.length);
        const branch = bits('1001000')
            .storeRef(bits('1010000010000001100001001').endCell())
            .storeRef(bits('1010000010000000001101111').endCell())
            .endCell();
        const cell = bits('1')
            .storeRef(bits('00').storeRef(branch).storeRef(bits('1011100000000000001100001001').endCell()).endCell())
            .endCell();
        const runtime = unwrap(TLBRuntime.from(TLBLib.HashmapE + '_ v:(HashmapE 8 uint16) = Example;'));
        const data = runtime.decodeCell(cell, { rootType: 'Example' });
        const entries = [
            [1, 777],
            [17, 111],
            [128, 777],
        ] as const;
        expect(Array.from(data.v as Dictionary<number, number>)).toEqual(entries);
        const expected = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Uint(16));
        for (const [key, value] of entries) expected.set(key, value);
        expect(runtime.encodeCell(data).toBoc()).toEqual(beginCell().storeDict(expected).endCell().toBoc());
    });

    it('rejects the spare bit patterns in a bounded natural', () => {
        const runtime = unwrap(TLBRuntime.from('_ x:(#<= 4) = Example;'));
        for (const x of [5, 6, 7]) {
            expect(() => runtime.decodeCell(beginCell().storeUint(x, 3).endCell(), { rootType: 'Example' })).toThrow();
            expect(() => runtime.encodeCell({ kind: 'Example', x })).toThrow();
        }
    });

    it('rejects the issue vector missing augmented root and fork extras', () => {
        const runtime = unwrap(
            TLBRuntime.from(
                TLBLib.Grams +
                    TLBLib.HashmapAugE +
                    'fip$_ y:(## 5) = FixedIntParam; _$_ x:(HashmapAugE 16 Grams FixedIntParam) = Example;',
            ),
        );
        const cell = Cell.fromHex('b5ee9c72410104010015000101c00102059c000c02030005558844000544881cb03ae0fb');
        expect(() => runtime.decodeCell(cell, { rootType: 'Example' })).toThrow();
        expect(() => runtime.encodeCell({ kind: 'Example', x: Dictionary.empty() })).toThrow(/extra/);
    });

    const pfxSchema = TLBHmLabel + definitions(/^phm/) + '_ v:(PfxHashmapE 1 uint8) = Example;';
    const varSchema = TLBHmLabel + TLBStd.Maybe + definitions(/^vhm/) + '_ v:(VarHashmapE 1 uint8) = Example;';
    const augSchema = TLBLib.HashmapAugE + '_ v:(HashmapAugE 1 uint8 uint4) = Example;';
    const pfxLeaf = label().storeBit(0).storeUint(42, 8).endCell();
    const varLeaf = label().storeUint(0, 2).storeUint(42, 8).endCell();
    const augLeaf = label().storeUint(3, 4).storeUint(42, 8).endCell();
    const root = (cell: Cell) => beginCell().storeBit(1).storeRef(cell);
    it.each([
        ['PfxHashmapE empty', pfxSchema, beginCell().storeBit(0).endCell()],
        ['PfxHashmap leaf', pfxSchema, root(pfxLeaf).endCell()],
        [
            'PfxHashmap fork',
            pfxSchema,
            root(label().storeBit(1).storeRef(pfxLeaf).storeRef(pfxLeaf).endCell()).endCell(),
        ],
        ['VarHashmapE empty', varSchema, beginCell().storeBit(0).endCell()],
        ['VarHashmap leaf', varSchema, root(varLeaf).endCell()],
        ...[false, true].map((present) => {
            const fork = label().storeUint(1, 2).storeRef(varLeaf).storeRef(varLeaf).storeBit(present);
            if (present) fork.storeUint(9, 8);
            return [`VarHashmap fork, value ${present}`, varSchema, root(fork.endCell()).endCell()] as const;
        }),
        ...[false, true].map(
            (branch) =>
                [
                    `VarHashmap continuation ${branch}`,
                    varSchema,
                    root(label().storeBit(1).storeBit(branch).storeRef(varLeaf).storeUint(9, 8).endCell()).endCell(),
                ] as const,
        ),
        ['HashmapAugE empty with extra', augSchema, beginCell().storeBit(0).storeUint(7, 4).endCell()],
        [
            'HashmapAug fork, leaves and root with extras',
            augSchema,
            root(label().storeRef(augLeaf).storeRef(augLeaf).storeUint(6, 4).endCell()).storeUint(6, 4).endCell(),
        ],
    ] as const)('%s', (_, schema, cell) => {
        check(schema, cell);
    });

    it('BinTreeAug fork and leaves', () => {
        const leaf = (n: number) => beginCell().storeBit(0).storeUint(2, 4).storeUint(n, 8).endCell();
        check(
            definitions(/^bta_/) + '_ t:(BinTreeAug uint8 uint4) = Example;',
            beginCell().storeBit(1).storeRef(leaf(7)).storeRef(leaf(9)).storeUint(4, 4).endCell(),
        );
    });

    const address = new Address(0, Buffer.alloc(32, 0x12));
    const payload = beginCell().storeUint(5, 3).endCell();
    const prelude = TLBLib.MsgAddress + TLBStd.VarUInteger + TLBStd.Either;
    for (const nft of [false, true]) {
        const name = nft ? 'NFT' : 'Jetton';
        const s =
            prelude +
            (nft
                ? 'transfer#5fcc3d14 query_id:uint64 new_owner:MsgAddress response_destination:MsgAddress custom_payload:(Maybe ^Cell) forward_amount:(VarUInteger 16)'
                : 'transfer#0f8a7ea5 query_id:uint64 amount:(VarUInteger 16) destination:MsgAddress response_destination:MsgAddress custom_payload:(Maybe ^Cell) forward_ton_amount:(VarUInteger 16)') +
            ' forward_payload:(Either Cell ^Cell) = Example;';
        for (const custom of [false, true])
            for (const ref of [false, true]) {
                it(`${name} transfer, custom payload ${custom}, forwarded reference ${ref}`, () => {
                    const b = beginCell()
                        .storeUint(nft ? 0x5fcc3d14 : 0xf8a7ea5, 32)
                        .storeUint(17, 64);
                    if (!nft) b.storeCoins(27583);
                    b.storeAddress(address)
                        .storeAddress(address)
                        .storeMaybeRef(custom ? payload : null)
                        .storeCoins(7)
                        .storeBit(ref);
                    if (ref) b.storeRef(payload);
                    else b.storeSlice(payload.beginParse());
                    check(s, b.endCell());
                });
            }
    }
    it.each([false, true])('Jetton notification, forwarded reference %s', (ref) => {
        const s =
            prelude +
            'transfer_notification#7362d09c query_id:uint64 amount:(VarUInteger 16) sender:MsgAddress forward_payload:(Either Cell ^Cell) = Example;';
        const b = beginCell()
            .storeUint(0x7362d09c, 32)
            .storeUint(123, 64)
            .storeCoins(27583)
            .storeAddress(address)
            .storeBit(ref);
        if (ref) b.storeRef(payload);
        else b.storeSlice(payload.beginParse());
        check(s, b.endCell());
    });

    const dns =
        TLBLib.MsgAddress +
        definitions(/^(proto_|cap_list_|cap_is_wallet|dns_(next_resolver|storage_address|smc_address|adnl_address))/);
    it('preserves the DNS ADNL sample address as 256 raw bits with autoText enabled', () => {
        const runtime = unwrap(TLBRuntime.from(dns, { autoText: true }));
        const cell = Cell.fromBase64('te6cckEBAQEAKAAAS60BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHsBpCogujAahw==');
        const data = runtime.decodeCell(cell, { rootType: 'DNSRecord' });
        expect(data.adnl_addr).toBeInstanceOf(BitString);
        expect((data.adnl_addr as BitString).equals(beginCell().storeUint(123, 256).endCell().bits)).toBe(true);
        expect(runtime.encodeCell(data).equals(cell)).toBe(true);
    });

    it.each([
        ['ASCII', Buffer.from('Hello'), 'Hello'],
        ['Unicode and whitespace', Buffer.from('Привет 👋\t\r\n'), 'Привет 👋\t\r\n'],
        ['invalid UTF-8', Buffer.from([0xc0, 0xaf]), null],
        ['control character', Buffer.from([0x61, 0x7f]), null],
    ] as const)('round-trips %s in an unaligned length-prefixed field', (_, bytes, text) => {
        const runtime = unwrap(TLBRuntime.from('_ len:(## 7) text:(bits (len * 8)) = Message;'));
        const cell = beginCell().storeUint(bytes.length, 7).storeBuffer(bytes).endCell();
        const data = runtime.decodeCell(cell, { rootType: 'Message' });
        if (text === null) {
            expect(data.text).toBeInstanceOf(BitString);
            expect((data.text as BitString).equals(beginCell().storeBuffer(bytes).endCell().bits)).toBe(true);
        } else {
            expect(data.text).toBe(text);
        }
        expect(runtime.encodeCell(data).equals(cell)).toBe(true);
    });

    const records = [
        ['next resolver', beginCell().storeUint(0xba93, 16).storeAddress(address).endCell()],
        ['storage', beginCell().storeUint(0x7473, 16).storeUint(123, 256).endCell()],
    ] as const;
    it.each(records)('DNS %s', (_, cell) => {
        check(dns, cell, 'DNSRecord');
    });
    for (const adnl of [false, true])
        for (const count of [-1, 0, 1]) {
            it(`DNS ${adnl ? 'ADNL' : 'SMC'}, list length ${count < 0 ? 'absent' : count}`, () => {
                const b = beginCell().storeUint(adnl ? 0xad01 : 0x9fd3, 16);
                if (adnl) b.storeUint(123, 256);
                else b.storeAddress(address);
                b.storeUint(count < 0 ? 0 : 1, 8);
                if (count === 1) b.storeBit(1).storeUint(adnl ? 0x4854 : 0x2177, 16);
                if (count >= 0) b.storeBit(0);
                check(dns, b.endCell(), 'DNSRecord');
            });
        }
    it('DNS record set references the stored record', () => {
        const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()).set(9n, records[0][1]);
        check(
            dns + TLBLib.HashmapE + '_ records:(HashmapE 256 ^DNSRecord) = Example;',
            beginCell().storeDict(dict).endCell(),
        );
    });
});
