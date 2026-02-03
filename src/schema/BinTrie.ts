import { Undefined } from './TypeHelpers';

export class BinTrie {
    /** Left subtree */
    left: BinTrie | null;

    /** Right subtree */
    right: BinTrie | null;

    /** Node tag */
    tag: bigint;

    /** Subtree tag */
    downTag: bigint;

    /** Useful depth */
    usefulDepth: number;

    constructor(tag: bigint = 0n, left: BinTrie | null = null, right: BinTrie | null = null) {
        this.left = left;
        this.right = right;
        this.tag = tag;
        this.downTag = 0n;
        this.usefulDepth = 0;
    }

    /**
     * Whether it is unique
     */
    isUnique(): boolean {
        return (this.downTag & (this.downTag - 1n)) === 0n;
    }

    /**
     * Unique value
     */
    uniqueValue(): number {
        if (this.downTag === 0n) {
            return Undefined;
        }
        // Count trailing zeroes
        let count = 0;
        let val = this.downTag;
        while ((val & 1n) === 0n && val !== 0n) {
            count++;
            val >>= 1n;
        }
        return count;
    }

    /**
     * Search for tag by path
     */
    lookupTag(path: bigint): bigint {
        const node = this.lookupNodeConst(path);
        return node ? node.tag : 0n;
    }

    /**
     * Search for node by path (const)
     */
    lookupNodeConst(path: bigint): BinTrie | null {
        if (path === 0n) {
            return null;
        }
        const mask = (1n << 63n) - 1n;
        if ((path & mask) === 0n) {
            return this;
        }
        // Examine the highest bit to decide direction
        if ((path & (1n << 62n)) === 0n) {
            // Go left
            return this.left ? (this.left as BinTrie).lookupNodeConst(path & ((1n << 62n) - 1n)) : null;
        } else {
            // Go right
            return this.right ? (this.right as BinTrie).lookupNodeConst(path & ((1n << 62n) - 1n)) : null;
        }
    }

    /**
     * Search for node by path
     */
    lookupNode(path: bigint): BinTrie | null {
        return this.lookupNodeConst(path);
    }

    /**
     * Insert path
     */
    insPath(path: bigint, newTag: bigint): void {
        if (path === 0n || newTag === 0n) {
            return;
        }
        const mask = (1n << 63n) - 1n;
        if ((path & mask) === 0n) {
            this.tag |= newTag;
            return;
        }
        // Check the highest bit to decide direction
        if ((path & (1n << 62n)) === 0n) {
            // Go left
            if (!this.left) {
                this.left = new BinTrie();
            }
            (this.left as BinTrie).insPath((path << 1n) & mask, newTag);
        } else {
            // Go right
            if (!this.right) {
                this.right = new BinTrie();
            }
            (this.right as BinTrie).insPath((path << 1n) & mask, newTag);
        }
        if (this.left && this.right) {
            this.tag |= this.left.tag & this.right.tag;
        }
    }

    /**
     * Compute useful depth
     */
    computeUsefulDepth(colors: bigint = 0n): number {
        let res = 0;
        this.downTag = this.tag = colors | this.tag;
        if (this.left instanceof BinTrie) {
            res = (this.left as BinTrie).computeUsefulDepth(colors);
            this.downTag |= (this.left as BinTrie).downTag;
        }
        if (this.right instanceof BinTrie) {
            res = Math.max(res, (this.right as BinTrie).computeUsefulDepth(colors));
            this.downTag |= this.right.downTag;
        }
        if (res > 0) {
            return (this.usefulDepth = res + 1);
        }
        if (
            this.left &&
            this.right &&
            (this.left.downTag & ~this.right.downTag) !== 0n &&
            (this.right.downTag & ~this.left.downTag) !== 0n
        ) {
            return (this.usefulDepth = 1);
        }
        return (this.usefulDepth = 0);
    }

    /**
     * Convert to string
     */
    toString(pfx: bigint = 1n << 63n): string {
        let result = '';
        let x = pfx;
        const mask = (1n << 63n) - 1n;
        while ((x & mask) !== 0n) {
            result += x >> 63n === 1n ? '1' : '0';
            x <<= 1n;
        }
        result += ` t=${this.tag}; dt=${this.downTag}; ud=${this.usefulDepth}\n`;
        if (this.left) {
            result += (this.left as BinTrie).toString(pfx << 1n);
        }
        if (this.right) {
            result += (this.right as BinTrie).toString((pfx << 1n) | 1n);
        }
        return result;
    }

    private lowestBit(x: bigint): bigint {
        return x & -x;
    }
}
