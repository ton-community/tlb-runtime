import { BitString, Cell } from '@ton/core';

import { TLBDataError } from './errors';
import { Result } from './Result';

export function stringToBits(text: string): BitString {
    const bytes = Buffer.from(text, 'utf-8');
    return new BitString(bytes, 0, bytes.length * 8);
}

export function decodeBits(bits: BitString, autoText = true): BitString | string | boolean {
    if (bits.length === 1) return bits.at(0);
    const raw = normalizeBitString(bits);
    if (!autoText || bits.length % 8 !== 0) return raw;

    const bytes = raw.subbuffer(0, raw.length)!;
    const text = bytes.toString('utf8');
    // Buffer substitutes malformed UTF-8. Only return text that encodes back to the exact bytes.
    if (!Buffer.from(text, 'utf8').equals(bytes)) return raw;
    for (const char of text) {
        if (/\p{Cc}/u.test(char) && char !== '\t' && char !== '\n' && char !== '\r') return raw;
    }
    return text;
}

export function normalizeBitString(bits: BitString): BitString {
    const length = bits.length;
    const newBuffer = Buffer.alloc(Math.ceil(length / 8));

    for (let i = 0; i < length; i++) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = 7 - (i % 8);

        if (bits.at(i)) {
            newBuffer[byteIndex] |= 1 << bitIndex;
        }
    }
    return new BitString(newBuffer, 0, length);
}

export function toCell(data: string): Result<Cell> {
    try {
        return { success: true, value: Cell.fromBase64(data) };
    } catch (_) {
        try {
            return { success: true, value: Cell.fromHex(data) };
        } catch (_) {
            return { success: false, error: new TLBDataError('Bad BoC string') };
        }
    }
}
