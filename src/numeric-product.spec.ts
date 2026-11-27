import { beginCell } from '@ton/core';

import { runtimeBy, TLBDataError } from './index';

it('binds a numeric product in the parent scope', () => {
    const runtime = runtimeBy('_ {n:#} v:(## n) = Small n; _ m:(## 3) s:(Small (2 * m)) = Box;');
    const value = { kind: 'Box', m: 3, s: { kind: 'Small', v: 9 } };
    const wire = beginCell().storeUint(3, 3).storeUint(9, 6).endCell();
    for (const params of [{}, { n: 6 }]) {
        expect(runtime.encodeCell({ ...value, s: { ...value.s, ...params } }).equals(wire)).toBe(true);
    }
    expect(runtime.decodeCell(wire)).toMatchObject({ ...value, s: { ...value.s, n: 6 } });
    expect(() => runtime.encodeCell({ ...value, s: { ...value.s, n: 5 } })).toThrow(TLBDataError);
});

it('solves both result arguments before reading the next field', () => {
    const r = runtimeBy('_ {n:#} {m:#} x:(## n) = Pair (n + m) (m + 1); _ x:(Pair 7 4) tail:uint8 = Wrapper;');
    const wire = beginCell().storeUint(10, 4).storeUint(85, 8).endCell();
    const value = { kind: 'Wrapper', x: { kind: 'Pair', n: 4, m: 3, x: 10 }, tail: 85 };
    expect(r.decodeCell(wire)).toEqual(value);
    expect(r.encodeCell(value).equals(wire)).toBe(true);
});

it('rejects a result argument with no natural solution', () => {
    const r = runtimeBy('_ {n:#} x:(## n) = Pair (2 * n); _ p:(Pair 5) = Box;');
    const wire = beginCell().storeUint(10, 5).endCell();
    expect(() => r.decodeCell(wire, { rootType: 'Box' })).toThrow(TLBDataError);
    expect(() => r.encodeCell({ kind: 'Box', p: { x: 10 } })).toThrow(TLBDataError);
});

it('enforces the byte count of an undeclared VarUInteger', () => {
    const r = runtimeBy('_ v:(VarUInteger 5) = Box;');
    const wire = beginCell().storeUint(4, 3).storeUint(0xffffffff, 32).endCell();
    const data = { kind: 'Box', v: 0xffffffffn };
    expect(r.encodeCell(data).equals(wire)).toBe(true);
    expect(r.decodeCell(wire)).toEqual(data);
    const invalid = beginCell().storeUint(5, 3).storeUint(1, 40).endCell();
    expect(() => r.decodeCell(invalid)).toThrow(TLBDataError);
    expect(() => r.encodeCell({ kind: 'Box', v: 1n << 32n })).toThrow(TLBDataError);
});

it.each([
    [3, -7],
    [10, 0],
])('solves a natural predecessor of %i', (x, y) => {
    const r = runtimeBy('_ x:(## 8) { y:# } { ~y + 10 = x } = Box;');
    const wire = beginCell().storeUint(x, 8).endCell();
    const value = { kind: 'Box', x };
    if (y < 0) {
        expect(() => r.decodeCell(wire)).toThrow(TLBDataError);
        expect(() => r.encodeCell(value)).toThrow(TLBDataError);
        expect(() => r.encodeCell({ ...value, y })).toThrow(TLBDataError);
    } else {
        expect(r.decodeCell(wire)).toEqual({ ...value, y });
        expect(r.encodeCell(value).equals(wire)).toBe(true);
    }
});
