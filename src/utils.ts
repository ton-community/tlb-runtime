export function toUint8Array(data: string): Uint8Array {
    const result = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
        result[i] = data.charCodeAt(i) & 0xff;
    }
    return result;
}

const POLYNOMIAL = -306674912;

export function crc32(data: Uint8Array | string, crc = 0xffffffff): number {
    if (typeof data === 'string') {
        data = toUint8Array(data);
    }
    let result = crc;

    for (let n = 0; n < data.length; n++) {
        result ^= data[n];

        result = result & 1 ? (result >>> 1) ^ POLYNOMIAL : result >>> 1;
        result = result & 1 ? (result >>> 1) ^ POLYNOMIAL : result >>> 1;
        result = result & 1 ? (result >>> 1) ^ POLYNOMIAL : result >>> 1;
        result = result & 1 ? (result >>> 1) ^ POLYNOMIAL : result >>> 1;
        result = result & 1 ? (result >>> 1) ^ POLYNOMIAL : result >>> 1;
        result = result & 1 ? (result >>> 1) ^ POLYNOMIAL : result >>> 1;
        result = result & 1 ? (result >>> 1) ^ POLYNOMIAL : result >>> 1;
        result = result & 1 ? (result >>> 1) ^ POLYNOMIAL : result >>> 1;
    }

    return (result ^ -1) >>> 0;
}
