import { Undefined } from './Type';

export class AdmissibilityInfo {
    dimension: number;

    /** Array of boolean values */
    info: boolean[];

    constructor() {
        this.dimension = 0;
        this.info = [false];
    }

    setAll(value: boolean = true): void {
        this.dimension = 0;
        this.info = [value];
    }

    clearAll(): void {
        this.setAll(false);
    }

    extend(dim1: number): void {
        if (this.dimension < dim1) {
            const n = this.info.length;
            const n1 = 1 << (2 * dim1);
            this.info.length = n1;
            for (let i = n; i < n1; i++) {
                this.info[i] = this.info[i - n];
            }
            this.dimension = dim1;
        }
    }

    /**
     * Operator |=
     */
    orAssign(other: AdmissibilityInfo): void {
        this.extend(other.dimension);
        const n = this.info.length;
        const n1 = other.info.length;
        for (let i = 0, j = 0; i < n; i++) {
            this.info[i] = this.info[i] || other.info[j];
            j = (j + 1) & (n1 - 1);
        }
    }

    setByPattern(pdim: number, pattern: number[]): void {
        this.extend(pdim);
        const n = this.info.length;
        for (let x = 0; x < n; x++) {
            let y = x;
            let f = true;
            for (let i = 0; i < pdim; i++) {
                if (!((pattern[i] >> (y & 3)) & 1)) {
                    f = false;
                    break;
                }
                y >>= 2;
            }
            if (f) {
                this.info[x] = true;
            }
        }
    }

    isSetAll(): boolean {
        if (this.dimension === 0) {
            return this.info[0];
        }
        // For higher dimensions, check if all entries are true
        return this.info.every((x) => x);
    }

    /**
     * Check if no entries are set (empty admissibility)
     */
    isNoneSet(): boolean {
        return this.info.every((x) => !x);
    }

    get(index: number): boolean {
        return this.info[index & (this.info.length - 1)];
    }

    conflictsWith(other: AdmissibilityInfo): boolean {
        return this.conflictsAt(other) >= 0;
    }

    conflictsAt(other: AdmissibilityInfo): number {
        const n1 = this.info.length;
        const n2 = other.info.length;
        const n = Math.max(n1, n2);
        for (let i = 0; i < n; i++) {
            if (this.get(i) && other.get(i)) {
                return i;
            }
        }
        return Undefined;
    }

    toString(): string {
        return `[${this.info.map((x) => (x ? '1' : '0')).join('')}]`;
    }
}
