import { beginCell } from '@ton/core';

import { runtimeBy } from './index';

it.each([
    ['>=', 0x7dd95f33, 6],
    ['<=', 0x1c4a843d, 4],
] as const)('uses the canonical tlbc tag for %s', (op, tag, a) => {
    const runtime = runtimeBy(`sample a:(## 8) { a ${op} 5 } = Test;`);
    const wire = beginCell().storeUint(tag, 32).storeUint(a, 8).endCell();
    const value = { kind: 'Test', a };
    expect(runtime.decodeCell(wire)).toEqual(value);
    expect(runtime.encodeCell(value).equals(wire)).toBe(true);
});

it('preserves the empty tag encoded by #8_', () => {
    const runtime = runtimeBy('_#8_ x:uint8 = Box;');
    const wire = beginCell().storeUint(42, 8).endCell();
    const value = { kind: 'Box', x: 42 };
    expect(runtime.decodeCell(wire)).toEqual(value);
    expect(runtime.encodeCell(value).equals(wire)).toBe(true);
});

it('uses the real declaration after commented-out constructors', () => {
    const r = runtimeBy('/* note;\nfoo#_ x:uint8 = Foo;\n*/\n// foo$0 = Foo;\nfoo#ab x:uint8 = Foo;');
    const wire = beginCell().storeUint(0xab07, 16).endCell();
    const value = { kind: 'Foo', x: 7 };
    expect(r.getTypes().get('Foo')?.constructors[0].declaration).toBe('foo#ab x:uint8 = Foo;');
    expect(r.decodeCell(wire)).toEqual(value);
    expect(r.encodeCell(value).equals(wire)).toBe(true);
});
