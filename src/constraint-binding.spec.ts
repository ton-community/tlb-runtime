import { beginCell } from '@ton/core';

import { TLBHmLabel } from './tesdata';
import { runtimeBy, TLBDataError } from './index';

const byte = (n: number) => beginCell().storeUint(n, 8).endCell();

it('rejects unsolved equalities and tries the next constructor', () => {
    const r = runtimeBy('a$_ x:(## 8) { y:# } { 2 * y = x } = Parity; b$_ x:(## 8) = Parity;');
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

const unary = 'zero$0 = Unary ~0; succ$1 {n:#} x:(Unary ~n) = Unary ~(n + 1);';

it('checks a concrete output argument against the decoded Unary length', () => {
    const r = runtimeBy(unary + '_ u:(Unary 2) = Box;');
    const read = (n: number, bits: number) =>
        r.decodeCell(beginCell().storeUint(n, bits).endCell(), { rootType: 'Box' });
    expect(read(6, 3)).toMatchObject({ kind: 'Box' });
    expect(() => read(2, 2)).toThrow(TLBDataError);
});

it('requires both children to agree on the same output variable', () => {
    const r = runtimeBy(unary + '_ {n:#} a:(Unary ~n) b:(Unary ~n) = Same;');
    const read = (b: number, bits: number) =>
        r.decodeCell(beginCell().storeUint(6, 3).storeUint(b, bits).endCell(), { rootType: 'Same' });
    expect(read(6, 3)).toMatchObject({ n: 2 });
    expect(() => read(2, 2)).toThrow(/Conflicting output parameter/);
});

it('derives the width of the first wire field from an argument', () => {
    const r = runtimeBy('_ {n:#} {m:#} { m = n + 1 } x:(uint m) = Box n; _ b:(Box 3) = Root;');
    const wire = beginCell().storeUint(13, 4).endCell();
    expect(r.decodeCell(wire)).toMatchObject({ b: { m: 4, x: 13 } });
    expect(r.encodeCell({ kind: 'Root', b: { x: 13 } }).equals(wire)).toBe(true);
});

it('solves chained equalities when the constructor has no wire fields', () => {
    const r = runtimeBy('_ {k:#} {n:#} {m:#} { n = m + 1 } { m = k + 1 } = Foo k; _ f:(Foo 5) = Bar;');
    const wire = beginCell().endCell();
    expect(r.decodeCell(wire)).toMatchObject({ f: { k: 5, m: 6, n: 7 } });
    expect(r.encodeCell({ kind: 'Bar', f: { kind: 'Foo' } }).equals(wire)).toBe(true);
});

it('keeps numeric arguments on a type sharing its formal parameter name', () => {
    const r = runtimeBy('_ {n:#} v:(uint n) = X n; _ {X:Type} a:X = Wrap X; _ w:(Wrap (X 4)) tail:uint8 = Root;');
    const wire = beginCell().storeUint(13, 4).storeUint(85, 8).endCell();
    const data = r.decodeCell(wire, { rootType: 'Root' });
    expect(data).toMatchObject({ w: { a: { n: 4, v: 13 } }, tail: 85 });
    expect(r.encodeCell(data).equals(wire)).toBe(true);
});

it('validates a compound result after reading both wire operands', () => {
    const r = runtimeBy('_ x:(## 4) y:(## 4) = Sum (x + y); _ s:(Sum 7) = Box;');
    expect(r.decodeCell(byte(0x34), { rootType: 'Box' })).toMatchObject({ s: { x: 3, y: 4 } });
    expect(() => r.decodeCell(byte(0x35), { rootType: 'Box' })).toThrow(TLBDataError);
});

it.each(['x', '~x'])('checks the decoded wire field against concrete result %s', (result) => {
    const r = runtimeBy(`foo$0 x:(## 8) = Bar ${result}; _ b:(Bar 5) = Box;`);
    const read = (x: number) => r.decodeCell(beginCell().storeBit(0).storeUint(x, 8).endCell(), { rootType: 'Box' });
    expect(read(5)).toMatchObject({ b: { x: 5 } });
    expect(() => read(99)).toThrow(TLBDataError);
    expect(() => r.encodeCell({ kind: 'Box', b: { x: 99 } })).toThrow(TLBDataError);
});

it('checks the output length of a long HmLabel against its concrete argument', () => {
    const r = runtimeBy(TLBHmLabel + '_ label:(HmLabel 2 4) = Box;');
    const wire = (n: number) => beginCell().storeUint(2, 2).storeUint(n, 3).storeUint(0, n).endCell();
    const data = r.decodeCell(wire(2), { rootType: 'Box' });
    expect(r.encodeCell(data).equals(wire(2))).toBe(true);
    expect(() => r.decodeCell(wire(3), { rootType: 'Box' })).toThrow(TLBDataError);
});
