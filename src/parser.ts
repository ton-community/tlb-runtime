import { Address, BitString, Cell, ExternalAddress } from '@ton/core';

import { runtimeBy, DecodeCellOptions, TypedCell, ParsedCell, parseTLB } from './TLBRuntime';

export function decodeCell(schema: string, data: Cell | string, options?: DecodeCellOptions): TypedCell {
    return runtimeBy(schema).decodeCell(data, options);
}

/** @deprecated Use decodeCell instead. */
export function parseCell(schema: string, data: Cell | string): ParsedCell {
    return parseTLB(schema).parseCell(data);
}

/** @deprecated Pairs with parseCell. For the current compiler, use runtimeBy(schema).encodeCell(data). */
export function encodeCell(schema: string, data: unknown): Cell {
    return parseTLB(schema).encodeCell(data);
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
