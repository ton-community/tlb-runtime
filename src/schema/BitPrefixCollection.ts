import { PackedSize } from './Size';

// Interval structure to represent prefix ranges
class BitPrefixInterval {
    z: bigint = 0n;
    a: bigint = 0n;
    b: bigint = 0n;

    setValue(prefix: bigint): void {
        this.z = prefix;
        this.a = prefix & (prefix - 1n);
        this.b = prefix | (prefix - 1n);
    }

    contains(other: BitPrefixInterval): boolean {
        return this.a <= other.a && other.b <= this.b;
    }
}

export class BitPrefixCollection {
    static All = 1n;
    static Max = 63n;
    static Min = 0n;

    prefix: bigint[]; // 64bit

    constructor(onePfx?: bigint) {
        this.prefix = [];
        if (onePfx !== undefined && onePfx !== 0n) {
            this.prefix.push(onePfx);
        }
    }

    clear(): void {
        this.prefix = [];
    }

    all(): void {
        this.prefix = [BitPrefixCollection.All << BitPrefixCollection.Max];
    }

    empty(): boolean {
        return this.prefix.length === 0;
    }

    isAll(): boolean {
        return this.prefix.length === 1 && this.prefix[0] === BitPrefixCollection.All << BitPrefixCollection.Max;
    }

    min(): bigint {
        return this.prefix.length > 0 ? this.prefix[0] : BitPrefixCollection.Min;
    }

    mergeBack(size: PackedSize): void {
        if (this.prefix.length === 0) {
            this.prefix.push(size);
            return;
        }
        let z = size;
        // Get the lowest set bit (equivalent to td::lower_bit64)
        let w = z & -z;
        while (this.prefix.length > 0) {
            const t = z ^ this.prefix[this.prefix.length - 1];
            if (t === 0n) {
                return;
            }
            if (t !== w << 1n) {
                break;
            }
            z -= w;
            w <<= 1n;
            this.prefix.pop();
        }
        this.prefix.push(z);
    }

    /**
     * Operator +=
     */
    addAssign(other: BitPrefixCollection): boolean {
        const tmp = this.add(other);
        const changed = !this.equals(tmp);
        if (changed) {
            this.prefix = tmp.prefix;
        }
        return changed;
    }

    add(other: BitPrefixCollection): BitPrefixCollection {
        if (other.prefix.length === 0) {
            return this;
        }
        if (this.prefix.length === 0) {
            return other;
        }
        const result = new BitPrefixCollection();
        let i = 0;
        let j = 0;
        const m = this.prefix.length;
        const n = other.prefix.length;

        const U = new BitPrefixInterval();
        const V = new BitPrefixInterval();
        U.setValue(this.prefix[0]);
        V.setValue(other.prefix[0]);

        while (i < m && j < n) {
            if (U.b < V.b || (U.b === V.b && U.a >= V.a)) {
                if (U.a < V.a) {
                    result.mergeBack(U.z);
                }
                i++;
                if (i === m) {
                    break;
                }
                U.setValue(this.prefix[i]);
            } else {
                if (V.a < U.a) {
                    result.mergeBack(V.z);
                }
                j++;
                if (j === n) {
                    break;
                }
                V.setValue(other.prefix[j]);
            }
        }

        while (i < m) {
            result.mergeBack(this.prefix[i++]);
        }

        while (j < n) {
            result.mergeBack(other.prefix[j++]);
        }

        return result;
    }

    equals(other: BitPrefixCollection): boolean {
        if (this.prefix.length !== other.prefix.length) {
            return false;
        }
        for (let i = 0; i < this.prefix.length; i++) {
            if (this.prefix[i] !== other.prefix[i]) {
                return false;
            }
        }
        return true;
    }

    toString(): string {
        if (this.empty()) {
            return '{}';
        }
        if (this.isAll()) {
            return '{*}';
        }
        // Format each prefix as binary with trailing asterisk
        const parts = this.prefix.map((p) => {
            // Find the marker bit position (lowest set bit determines prefix length)
            let markerPos = 0;
            let temp = p;
            while ((temp & 1n) === 0n && markerPos < 64) {
                temp >>= 1n;
                markerPos++;
            }
            // The prefix length is 63 - markerPos
            const prefixLen = 63 - markerPos;
            if (prefixLen <= 0) {
                return '*';
            }
            // Extract the prefix bits (top prefixLen bits)
            const prefixValue = p >> BigInt(64 - prefixLen);
            // Convert to binary string
            const binStr = prefixValue.toString(2).padStart(prefixLen, '0');
            return binStr + '*';
        });
        return `{${parts.join(',')}}`;
    }
}
