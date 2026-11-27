import { Address, BitString, Cell, ExternalAddress } from '@ton/core';

import { TLBSchemaError, UnknownKindError } from './errors';
import { runtimeBy, DecodeCellOptions, TypedCell, ParsedCell, parseTLB } from './TLBRuntime';

export function decodeCell(schema: string, data: Cell | string, options?: DecodeCellOptions): TypedCell {
    return runtimeBy(schema).decodeCell(data, options);
}

/** @deprecated Use decodeCell instead. */
export function parseCell(schema: string, data: Cell | string): ParsedCell {
    return parseTLB(schema).parseCell(data);
}

export function encodeCell(schema: string, data: unknown): Cell {
    try {
        return runtimeBy(schema).encodeCell(data);
    } catch (error) {
        if (!(error instanceof TLBSchemaError || error instanceof UnknownKindError)) throw error;
        try {
            return parseTLB(schema).encodeCell(data);
        } catch {
            throw error;
        }
    }
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
