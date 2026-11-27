import { beginCell } from '@ton/core';

import { runtimeBy } from './index';
import { TLBStd } from './tesdata';

it('uses the output parameter of a referenced Unary to read the following field', () => {
    const r = runtimeBy(TLBStd.Unary + '_ {n:#} label:^(Unary ~n) x:(uint n) = Foo;');
    const two = beginCell().storeUint(0b110, 3).endCell();
    const cell = beginCell().storeRef(two).storeUint(3, 2).endCell();
    expect(r.decodeCell(cell, { rootType: 'Foo' })).toMatchObject({ kind: 'Foo', n: 2, x: 3 });
});
