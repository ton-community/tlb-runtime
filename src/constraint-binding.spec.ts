import { beginCell } from '@ton/core';

import { runtimeBy, TLBDataError } from './index';

const byte = (n: number) => beginCell().storeUint(n, 8).endCell();

it('rejects unsolved equalities and tries the next constructor', () => {
    const r = runtimeBy('b$_ x:(## 8) = Parity; a$_ x:(## 8) { y:# } { 2 * y = x } = Parity;');
    expect(r.decodeCell(byte(4))).toMatchObject({ kind: 'Parity_a', y: 2 });
    expect(r.decodeCell(byte(5))).toEqual({ kind: 'Parity_b', x: 5 });
    const only = runtimeBy('_ x:(## 8) { y:# } { 2 * y = x } = Foo;');
    expect(() => only.decodeCell(byte(5))).toThrow(TLBDataError);
});

it('skips implicit fields inside references and solves dependent equalities', () => {
    const r = runtimeBy('_ ^[ { n:# } { m:# } a:(## 8) { n = m + 1 } { m = a + 1 } ] = Box;');
    const cell = beginCell().storeRef(byte(5)).endCell();
    expect(r.decodeCell(cell)).toMatchObject({ kind: 'Box', a: 5, m: 6, n: 7 });
    expect(r.encodeCell({ kind: 'Box', a: 5 }).equals(cell)).toBe(true);
});

it.each([false, true])('binds a derived width before the next field (reference=%s)', (ref) => {
    const fields = 'a:(## 8) { m:# } { ~m + 1 = a } b:(uint m)';
    const r = runtimeBy(`_ ${ref ? '^[' + fields + ']' : fields} = Foo;`);
    const body = beginCell().storeUint(5, 8).storeUint(9, 4).endCell();
    const cell = ref ? beginCell().storeRef(body).endCell() : body;
    expect(r.decodeCell(cell)).toMatchObject({ kind: 'Foo', a: 5, b: 9, m: 4 });
    expect(r.encodeCell({ kind: 'Foo', a: 5, b: 9 }).equals(cell)).toBe(true);
});

it('propagates the output of a referenced group into the parent', () => {
    const r = runtimeBy(
        'zero$0 = Unary ~0; succ$1 {n:#} x:(Unary ~n) = Unary ~(n + 1); _ {n:#} ^[ u:(Unary ~n) ] x:(uint n) = Box;',
    );
    const wire = beginCell().storeRef(beginCell().storeUint(2, 2)).storeBit(1).endCell();
    const data = r.decodeCell(wire);
    expect(data).toMatchObject({ kind: 'Box', n: 1, x: 1 });
    expect(r.encodeCell(data).equals(wire)).toBe(true);
});

it.each([
    ['_ {X:Type} opt:(Maybe ^[ v:X ]) = Wrap X; _ w:(Wrap uint8) = Box;', true],
    ['_ n:uint4 opt:(Maybe ^[ v:(uint n) ]) = Box;', false],
] as const)('captures the scope of an anonymous Maybe argument in %s', (schema, generic) => {
    const r = runtimeBy('nothing$0 {X:Type} = Maybe X; just$1 {X:Type} value:X = Maybe X;' + schema);
    const root = beginCell();
    if (!generic) root.storeUint(4, 4);
    const wire = root
        .storeBit(1)
        .storeRef(beginCell().storeUint(13, generic ? 8 : 4))
        .endCell();
    const data = r.decodeCell(wire, { rootType: 'Box' });
    const record = { opt: { kind: 'Maybe_just', value: { v: 13 } } };
    expect(data).toMatchObject(generic ? { w: record } : record);
    expect(r.encodeCell(data).equals(wire)).toBe(true);
});
