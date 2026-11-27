import { beginCell } from '@ton/core';

import { parseTLB, runtimeBy } from './index';

const runtime = runtimeBy(
    [
        'none$0 {X:Type} = Maybe X;',
        'some$1 {X:Type} item:X = Maybe X;',
        '_ n:uint8 = Inner;',
        '_ entry:(Maybe Inner) = Box;',
    ].join(' '),
);

const inner = { kind: 'Inner', n: 42 };
const absent = beginCell().storeBit(0).endCell();
const present = beginCell().storeBit(1).storeUint(42, 8).endCell();

it.each([
    ['none', { kind: 'Maybe_none' }, absent],
    ['some', { kind: 'Maybe_some', item: inner }, present],
] as const)('round-trips the declared %s constructor', (_name, entry, wire) => {
    const box = runtime.decodeCell(wire, { rootType: 'Box' });
    expect(box.entry).toEqual(entry);
    expect(runtime.encodeCell(box).equals(wire)).toBe(true);
});

it('accepts a typed inner value as shorthand for a present Maybe', () => {
    expect(runtime.encodeCell({ kind: 'Box', entry: inner }).equals(present)).toBe(true);
});

it('preserves the legacy Maybe wrappers when the schema omits their declarations', () => {
    const legacy = parseTLB('_ entry:(Maybe uint8) = Box;');
    expect(legacy.encodeCell({ kind: 'Box', entry: { kind: 'Maybe_nothing' } }).equals(absent)).toBe(true);
    expect(legacy.encodeCell({ kind: 'Box', entry: { kind: 'Maybe_just', value: 42 } }).equals(present)).toBe(true);
});
