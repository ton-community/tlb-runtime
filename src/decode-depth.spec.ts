import { beginCell, Cell, Dictionary, serializeTuple, TupleItem } from '@ton/core';

import { parseTLB, runtimeBy } from './index';
import { TLBTVMReflection } from './tesdata';

const list = 'nil$0 = L; cons$1 v:(## 8) tail:^L = L;';
const nil = beginCell().storeBit(false).endCell();

it.each([parseTLB, runtimeBy])('decodes a 1023-reference list with %p', (compile) => {
    let wire = nil;
    for (let i = 0; i < 1023; i++)
        wire = beginCell()
            .storeBit(true)
            .storeUint(i % 256, 8)
            .storeRef(wire)
            .endCell();

    type List = { kind: 'L_nil' } | { kind: 'L_cons'; v: number; tail: List };
    let node = compile<List>(list).decodeCell(wire);
    for (let i = 1022; i >= 0; i--) {
        if (node.kind !== 'L_cons') throw new Error('List ended early');
        expect(node.v).toBe(i % 256);
        node = node.tail;
    }
    expect(node).toEqual({ kind: 'L_nil' });
});

it.each([parseTLB, runtimeBy])('reads a 99-entry VmStack with %p', (compile) => {
    const wire = serializeTuple(Array.from({ length: 99 }, (_, i) => ({ type: 'int', value: BigInt(i) })));
    const runtime = compile(TLBTVMReflection);
    expect(runtime.decodeCell(wire, { rootType: 'VmStack' })).toMatchObject({
        kind: 'VmStack',
        depth: 99,
    });
});

it('reports the configured depth limit and can decode again afterwards', () => {
    const runtime = runtimeBy(list, { maxDecodeDepth: 1 });
    const cons = beginCell().storeBit(true).storeUint(7, 8).storeRef(nil).endCell();
    expect(() => runtime.decodeCell(cons)).toThrow('Maximum decode depth (1) exceeded');
    expect(runtime.decodeCell(nil)).toEqual({ kind: 'L_nil' });
});

it.each([parseTLB, runtimeBy])('reads 300 nested dictionaries with %p', (compile) => {
    const depth = 300;
    let wire = beginCell().storeBit(false).endCell();
    for (let i = 0; i < depth; i++) {
        const entries = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell()).set(1, wire);
        wire = beginCell().storeDict(entries).endCell();
    }
    type Node = { kind: 'D'; d: Dictionary<number, Node> };
    const runtime = compile<Node>('_ d:(HashmapE 8 ^D) = D;');
    let node = runtime.decodeCell(wire, { rootType: 'D' });
    for (let i = 0; i < depth; i++) node = node.d.get(1)!;
    expect(node.d.size).toBe(0);
});

it('preserves the fields after an inline VmStack for every TON Core stack item', () => {
    const runtime = runtimeBy<{ stack: TupleItem[]; marker: number; end: Cell }>(
        TLBTVMReflection + '_ stack:VmStack marker:uint8 end:^Cell = Box;',
    );
    const marker = beginCell().storeUint(3, 2).endCell();
    const unit: TupleItem = { type: 'null' };
    const cases: TupleItem[][] = [
        [],
        [unit],
        [{ type: 'int', value: -8n }],
        [{ type: 'int', value: 1n << 80n }],
        [{ type: 'nan' }],
        ...(['cell', 'slice', 'builder'] as const).map((type) => [{ type, cell: marker }]),
        ...[[], [unit], [unit, unit]].map((items) => [{ type: 'tuple' as const, items }]),
    ];
    for (const stack of cases) {
        const wire = beginCell()
            .storeSlice(serializeTuple(stack).beginParse())
            .storeUint(71, 8)
            .storeRef(marker)
            .endCell();
        const data = runtime.decodeCell(wire, { rootType: 'Box' });
        expect(data.marker).toBe(71);
        expect(data.end.equals(marker)).toBe(true);
        expect(serializeTuple(data.stack).equals(serializeTuple(stack))).toBe(true);
    }
});
