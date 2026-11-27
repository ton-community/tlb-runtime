export type PackedSize = bigint;

export interface UnpackedSize {
    minBits: number;
    minRefs: number;
    maxBits: number;
    maxRefs: number;
}

export function isFixedSize(size: UnpackedSize): boolean {
    return size.minBits === size.maxBits && size.minRefs === size.maxRefs;
}

export function packSize(size: UnpackedSize): PackedSize {
    return (BigInt(size.minBits * 0x100 + size.minRefs) << 32n) + BigInt(size.maxBits * 0x100 + size.maxRefs);
}

function normalizeSize(size: PackedSize): PackedSize {
    // Ensure size is bigint (defensive check)
    if (size === undefined || size === null) {
        return 0n;
    }
    const s: bigint = typeof size === 'bigint' ? size : BigInt(size);
    const proc = (value: bigint, a: bigint, b: bigint) => ((value & a) !== 0n ? (value | (a | b)) - a : value);
    const mask = 0xfff800f8n * 0x100000001n;
    if ((s & mask) !== 0n) {
        let result = proc(s, 0xf8n, 0x7n);
        result = proc(result, 0xfff80000n, 0x7ff00n);
        result = proc(result, 0xf8n << 32n, 7n << 32n);
        result = proc(result, 0xfff80000n << 32n, 0x7ff00n << 32n);
        return result;
    }
    return s;
}

export function unpackSize(size: PackedSize): UnpackedSize {
    size = normalizeSize(size);
    const maxRefs = Number(size & 0xffn);
    const maxBits = Number((size >> 8n) & 0x7ffn);
    const minRefs = Number((size >> 32n) & 0xffn);
    const minBits = Number((size >> 40n) & 0x7ffn);
    return { minBits, minRefs, maxBits, maxRefs };
}

export class Size {
    static Any: PackedSize = 0x7ff07n;
    static OneRef: PackedSize = 0x100000001n;
    static Impossible: PackedSize = 0x7ff0700000000n;

    /** Packed size value (64 bits) */
    size: PackedSize;

    constructor(size: PackedSize = Size.Impossible, normalize: boolean = false) {
        this.size = size;
        if (normalize) {
            this.normalize();
        }
    }

    minSize(): number {
        return Number((this.size >> 32n) & 0xffffffffn);
    }

    maxSize(): number {
        return Number(this.size & 0xffffffffn);
    }

    minBits(): number {
        return (this.minSize() >> 8) & 0x7ff;
    }

    maxBits(): number {
        return (this.maxSize() >> 8) & 0x7ff;
    }

    minRefs(): number {
        return this.minSize() & 0xff;
    }

    maxRefs(): number {
        return this.maxSize() & 0xff;
    }

    isFixed(): boolean {
        return this.minSize() === this.maxSize();
    }

    fitsIntoCell(): boolean {
        const min = this.minSize();
        return !((0x3ff04 - min) & 0x80000080);
    }

    isPossible(): boolean {
        const min = this.minSize();
        const max = this.maxSize();
        return !((max - min) & 0x80000080);
    }

    normalize(): void {
        this.size = normalizeSize(this.size);
    }

    clear(): Size {
        this.size = 0n;
        return this;
    }

    clearMin(): Size {
        return new Size(this.size & ((1n << 32n) - 1n));
    }

    /**
     * Set infinite maximum
     */
    infiniteMax(): Size {
        this.size |= 0x3ff07n;
        return this;
    }

    add(other: Size): Size {
        return new Size(this.size + other.size, true);
    }

    /**
     * Operator +=
     */
    addAssign(other: Size): Size {
        this.size += other.size;
        this.size = normalizeSize(this.size);
        return this;
    }

    /**
     * Operator |=
     */
    orAssign(other: Size): Size {
        const z = this.unpack();
        const w = other.unpack();
        z.minRefs = Math.min(z.minRefs, w.minRefs);
        z.minBits = Math.min(z.minBits, w.minBits);
        z.maxRefs = Math.max(z.maxRefs, w.maxRefs);
        z.maxBits = Math.max(z.maxBits, w.maxBits);
        this.size = this.pack(z);
        return this;
    }

    repeat(count: number): Size {
        if (count <= 0) {
            return new Size(0n);
        }
        if (count === 1) {
            return new Size(this.size);
        }
        const size = this.unpack();
        count = Math.min(count, 1024);
        size.maxRefs = Math.min(size.maxRefs * count, 7);
        size.maxBits = Math.min(size.maxBits * count, 0x7ff);
        size.minRefs = Math.min(size.minRefs * count, 7);
        size.minBits = Math.min(size.minBits * count, 0x7ff);
        return new Size(this.pack(size));
    }

    repeatAtLeast(count: number): Size {
        count = Math.min(Math.max(count, 0), 1024);
        const size = this.unpack();
        if (size.maxRefs > 0) {
            size.maxRefs = 7;
        }
        if (size.maxBits > 0) {
            size.maxBits = 0x7ff;
        }
        size.minRefs = Math.min(size.minRefs * count, 7);
        size.minBits = Math.min(size.minBits * count, 0x7ff);
        return new Size(this.pack(size));
    }

    static anySize(): Size {
        return new Size(Size.Any);
    }

    static fixedSize(sz: number): Size {
        return new Size(BigInt(sz) * 0x10000000100n);
    }

    static sizeRange(minSz: number, maxSz: number): Size {
        const size = ((BigInt(minSz) << 32n) + BigInt(maxSz)) << 8n;
        return new Size(size);
    }

    private unpack(): UnpackedSize {
        return unpackSize(this.size);
    }

    private pack(size: UnpackedSize): PackedSize {
        return packSize(size);
    }

    equals(other: Size): boolean {
        return this.size === other.size;
    }

    notEquals(other: Size): boolean {
        return this.size !== other.size;
    }

    toString(): string {
        const size = this.unpack();
        const fixed = isFixedSize(size);
        let result = '';
        if (fixed) {
            result += '=';
        }
        if (size.minBits >= 1024 && size.minRefs >= 7) {
            result += 'infty';
        } else {
            result += size.minBits.toString();
            if (size.minRefs > 0) {
                result += `+${size.minRefs}R`;
            }
        }
        if (!fixed) {
            result += '..';
            if (size.maxBits >= 1024 && size.maxRefs >= 7) {
                result += 'infty';
            } else {
                result += size.maxBits.toString();
                if (size.maxRefs > 0) {
                    result += `+${size.maxRefs}R`;
                }
            }
        }
        return result;
    }
}
