import { beginCell } from '@ton/core';

import { runtimeBy, TLBDataError } from './index';

it.each(['Choice', '^Choice'])('requires a discriminator for ambiguous %s fields', (field) => {
    const r = runtimeBy(`a$0 x:uint8 = Choice; b$1 x:uint8 = Choice; _ c:${field} = Box;`);
    for (const c of [{ x: 8 }, { kind: 'Choice', x: 8 }, { kind: 'Other', x: 8 }]) {
        expect(() => r.encodeCell({ kind: 'Box', c })).toThrow(TLBDataError);
    }
    for (const [tag, kind] of [
        [0, 'Choice_a'],
        [1, 'Choice_b'],
    ] as const) {
        const inner = beginCell().storeBit(tag).storeUint(8, 8).endCell();
        const expected = field === 'Choice' ? inner : beginCell().storeRef(inner).endCell();
        expect(r.encodeCell({ kind: 'Box', c: { kind, x: 8 } }).equals(expected)).toBe(true);
    }
});

it('infers a constructor from a unique result argument or a single definition', () => {
    const r = runtimeBy('a$0 x:uint8 = Choice 0; b$1 x:uint8 = Choice 1; _ y:(Choice 1) = Only; _ c:Only = Box;');
    expect(
        r.encodeCell({ kind: 'Box', c: { y: { x: 8 } } }).equals(beginCell().storeBit(1).storeUint(8, 8).endCell()),
    ).toBe(true);
});

it.each(['_ rest:Cell', 'unknown$_ op:uint32 query_id:uint64'])('tries a matching tag before %s', (fallback) => {
    const r = runtimeBy(`transfer#0f8a7ea5 query_id:uint64 = Msg; ${fallback} = Msg; _ msg:Msg = Box;`);
    const wire = beginCell().storeUint(0x0f8a7ea5, 32).storeUint(17, 64).endCell();
    const msg = { kind: 'Msg_transfer', query_id: 17n };
    expect(r.decodeCell(wire, { rootType: 'Msg' })).toEqual(msg);
    expect(r.decodeCell(wire)).toEqual({ kind: 'Box', msg });
});
