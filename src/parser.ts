import { Address, BitString, Cell, ExternalAddress } from '@ton/core';

import { runtimeBy, TypedCell } from './TLBRuntime';

export function decodeCell(schema: string, data: Cell | string): TypedCell {
    return runtimeBy(schema).decodeCell(data);
}

export function encodeCell(schema: string, data: TypedCell | string): Cell {
    return runtimeBy(schema).encodeCell(data);
}

// FIXME
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function replacer(_key: string, value: any): any {
    if (typeof value === 'bigint') {
        return value.toString();
    } else if (value instanceof Address) {
        return value.toString();
    } else if (value instanceof ExternalAddress) {
        return value.toString();
    } else if (value instanceof BitString) {
        return value.toString();
    } else if (value instanceof Cell) {
        return value.toBoc().toString('base64');
    }
    return value;
}
