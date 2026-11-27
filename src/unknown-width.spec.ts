import { beginCell } from '@ton/core';

import { runtimeBy, TLBRuntime, TLBSchemaError } from './index';

it('rejects unknown width names at compilation and identifies the field', () => {
    const schema = '_ v:(uint typo) end:uint8 = Ex;';
    expect(TLBRuntime.from(schema)).toMatchObject({ success: false, error: expect.any(TLBSchemaError) });
    expect(() => runtimeBy(schema)).toThrow(/field v in Ex.*typo/);
});

it('accepts a declared width of zero', () => {
    const runtime = runtimeBy('_ n:uint4 v:(uint n) end:uint8 = Ex;');
    const cell = beginCell().storeUint(0, 4).storeUint(42, 8).endCell();
    const data = runtime.decodeCell(cell, { rootType: 'Ex' });
    expect(data).toMatchObject({ n: 0, v: 0, end: 42 });
    expect(runtime.encodeCell(data).equals(cell)).toBe(true);
});
