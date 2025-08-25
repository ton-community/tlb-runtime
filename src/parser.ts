import { Address, BitString, Cell } from '@ton/core';

import { ParsedCell, parseTLB } from './TLBRuntime';

export function parseCell(schema: string, data: Cell | string): ParsedCell {
    return parseTLB(schema).parseCell(data);
}

export function encodeCell(schema: string, data: ParsedCell | string): Cell {
    return parseTLB(schema).encodeCell(data);
}

// FIXME
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function replacer(_key: string, value: any): any {
    if (typeof value === 'bigint') {
        return value.toString();
    } else if (value instanceof Address) {
        return value.toString();
    } else if (value instanceof BitString) {
        return value.toString();
    } else if (value instanceof Cell) {
        return value.toBoc().toString('base64');
    }
    return value;
}
