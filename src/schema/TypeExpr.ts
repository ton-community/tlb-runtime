import { Type } from './Type';
import { symbolMap } from './SymbolMap';
import { Size } from './Size';

export enum TypeExprType {
    Type = 0,
    Param = 1,
    Apply = 2,
    Add = 3,
    IntConst = 7,
    Tuple = 8,
    Ref = 9,
    CondType = 10,
    GetBit = 5,
    MulConst = 6,
}

export class TypeExpr {
    tp: TypeExprType;
    typeApplied: Type | null;
    args: TypeExpr[];
    value: number;
    isNat: boolean;
    isNatSubtype: boolean;
    negated: boolean;
    tchkOnly: boolean;
    isConstexpr: number;

    constructor(
        tp: TypeExprType = TypeExprType.Type,
        typeApplied: Type | null = null,
        args: TypeExpr[] = [],
        value: number = 0,
        isNat: boolean = false,
        isNatSubtype: boolean = false,
        negated: boolean = false,
        tchkOnly: boolean = false,
        isConstexpr: number = 0,
    ) {
        this.tp = tp;
        this.typeApplied = typeApplied;
        this.args = args;
        this.value = value;
        this.isNat = isNat;
        this.isNatSubtype = isNatSubtype;
        this.negated = negated;
        this.tchkOnly = tchkOnly;
        this.isConstexpr = isConstexpr;
    }

    toString(): string {
        if (this.negated) {
            return `~${this.toStringInner()}`;
        }
        return this.toStringInner();
    }

    private toStringInner(): string {
        switch (this.tp) {
            case TypeExprType.Type:
                return 'Type';
            case TypeExprType.Param:
                // Use 1-based field index for parameter references (e.g., _1, _2)
                return `_${this.value + 1}`;
            case TypeExprType.Apply: {
                if (!this.typeApplied) return '?';
                const typeName = symbolMap.getName(this.typeApplied.typeNameId) || '?';
                if (this.args.length === 0) {
                    return typeName;
                }
                // Wrap complex sub-expressions (Add, MulConst) in parentheses
                const argStrs = this.args.map((a) => {
                    const str = a.toString();
                    if (a.tp === TypeExprType.Add || a.tp === TypeExprType.MulConst) {
                        return `(${str})`;
                    }
                    return str;
                });
                return `${typeName} ${argStrs.join(' ')}`;
            }
            case TypeExprType.Add:
                if (this.args.length === 2) {
                    return `${this.args[0].toString()} + ${this.args[1].toString()}`;
                } else if (this.args.length === 1) {
                    return `${this.args[0].toString()} + ${this.value}`;
                }
                return '?';
            case TypeExprType.MulConst:
                // Multiplication: multiplier * type (e.g., n * Bit)
                if (this.args.length >= 2) {
                    return `${this.args[0].toString()} * ${this.args[1].toString()}`;
                } else if (this.args.length === 1) {
                    // Legacy: value * args[0]
                    return `${this.value} * ${this.args[0].toString()}`;
                }
                return '?';
            case TypeExprType.GetBit:
                // Get bit operation: x . i
                if (this.args.length > 0) {
                    return `${this.args[0].toString()} . ${this.value}`;
                }
                return '?';
            case TypeExprType.IntConst:
                return `${this.value}`;
            case TypeExprType.Tuple:
                if (this.args.length === 2) {
                    return `${this.args[0].toString()} * ${this.args[1].toString()}`;
                }
                return '?';
            case TypeExprType.Ref:
                if (this.args.length >= 1) {
                    return `^(${this.args[0].toString()})`;
                }
                return '^?';
            case TypeExprType.CondType:
                if (this.args.length === 2) {
                    return `${this.args[0].toString()} ? ${this.args[1].toString()}`;
                }
                return '?';
            default:
                return '?';
        }
    }

    toNameString(): string {
        switch (this.tp) {
            case TypeExprType.Type:
                return 'Type';
            case TypeExprType.Param:
                // Use 1-based index format for toNameString
                return `_${this.value + 1}`;
            case TypeExprType.Apply:
                if (!this.typeApplied) return '?';
                return symbolMap.getName(this.typeApplied.typeNameId) || '?';
            case TypeExprType.Add:
                return '+';
            case TypeExprType.MulConst:
                return '*';
            case TypeExprType.GetBit:
                return '.';
            case TypeExprType.IntConst:
                return `${this.value}`;
            case TypeExprType.Tuple:
                return 'Tuple';
            case TypeExprType.Ref:
                return '^';
            case TypeExprType.CondType:
                return '?:';
            default:
                return '?';
        }
    }

    /**
     * Convert TypeExpr to declaration string using original field names.
     * This is used for generating the TL-B declaration line.
     */
    toDeclarationString(fields: { name: number }[]): string {
        if (this.negated) {
            return `~${this.toDeclarationStringInner(fields)}`;
        }
        return this.toDeclarationStringInner(fields);
    }

    private toDeclarationStringInner(fields: { name: number }[]): string {
        switch (this.tp) {
            case TypeExprType.Type:
                return 'Type';
            case TypeExprType.Param: {
                // Look up original field name
                const fieldIdx = this.value;
                if (fieldIdx >= 0 && fieldIdx < fields.length) {
                    const fieldName = symbolMap.getName(fields[fieldIdx].name);
                    if (fieldName) {
                        return fieldName;
                    }
                }
                return `_${fieldIdx + 1}`;
            }
            case TypeExprType.Apply: {
                if (!this.typeApplied) return '?';
                const typeName = symbolMap.getName(this.typeApplied.typeNameId) || '?';
                if (this.args.length === 0) {
                    return typeName;
                }
                // Wrap complex sub-expressions (Add, MulConst) in parentheses
                const argStrs = this.args.map((a) => {
                    const str = a.toDeclarationString(fields);
                    if (a.tp === TypeExprType.Add || a.tp === TypeExprType.MulConst) {
                        return `(${str})`;
                    }
                    return str;
                });
                return `${typeName} ${argStrs.join(' ')}`;
            }
            case TypeExprType.Add:
                if (this.args.length === 2) {
                    return `${this.args[0].toDeclarationString(fields)} + ${this.args[1].toDeclarationString(fields)}`;
                } else if (this.args.length === 1) {
                    return `${this.args[0].toDeclarationString(fields)} + ${this.value}`;
                }
                return '?';
            case TypeExprType.MulConst:
                if (this.args.length >= 2) {
                    return `${this.args[0].toDeclarationString(fields)} * ${this.args[1].toDeclarationString(fields)}`;
                } else if (this.args.length === 1) {
                    return `${this.value} * ${this.args[0].toDeclarationString(fields)}`;
                }
                return '?';
            case TypeExprType.GetBit:
                if (this.args.length > 0) {
                    return `${this.args[0].toDeclarationString(fields)} . ${this.value}`;
                }
                return '?';
            case TypeExprType.IntConst:
                return `${this.value}`;
            case TypeExprType.Tuple:
                if (this.args.length === 2) {
                    return `${this.args[0].toDeclarationString(fields)} * ${this.args[1].toDeclarationString(fields)}`;
                }
                return '?';
            case TypeExprType.Ref:
                if (this.args.length >= 1) {
                    return `^(${this.args[0].toDeclarationString(fields)})`;
                }
                return '^?';
            case TypeExprType.CondType:
                if (this.args.length === 2) {
                    return `${this.args[0].toDeclarationString(fields)} ? ${this.args[1].toDeclarationString(fields)}`;
                }
                return '?';
            default:
                return '?';
        }
    }

    /**
     * Abstract interpretation of nat expressions
     * Based on abstract_interpret_nat in tlbc.cpp (line 1269-1310)
     * Returns a 4-bit value representing properties:
     * - 0x1: can be 0
     * - 0x2: can be 1
     * - 0x4: can be even >=2
     * - 0x8: can be odd >=3
     */
    abstractInterpretNat(): number {
        if (!this.isNat) {
            return 0xf; // unknown
        }
        switch (this.tp) {
            case TypeExprType.Param:
                return 0xf; // unknown
            case TypeExprType.IntConst:
                return this.abstractNatConst(this.value);
            case TypeExprType.Add:
                if (this.args.length === 2) {
                    return this.abstractAdd(this.args[0].abstractInterpretNat(), this.args[1].abstractInterpretNat());
                } else if (this.args.length === 1) {
                    return this.abstractAdd(this.args[0].abstractInterpretNat(), this.abstractNatConst(this.value));
                }
                return 0xf;
            case TypeExprType.MulConst:
                if (this.args.length >= 2) {
                    return this.abstractMul(this.args[0].abstractInterpretNat(), this.args[1].abstractInterpretNat());
                } else if (this.args.length === 1) {
                    return this.abstractMul(this.abstractNatConst(this.value), this.args[0].abstractInterpretNat());
                }
                return 0xf;
            case TypeExprType.GetBit:
                if (this.args.length >= 2) {
                    return this.abstractGetBit(
                        this.args[0].abstractInterpretNat(),
                        this.args[1].abstractInterpretNat(),
                    );
                }
                return 0xf;
            default:
                return 0xf;
        }
    }

    /**
     * Abstract interpretation for constant values
     */
    private abstractNatConst(value: number): number {
        if (value === 0) return 1;
        if (value === 1) return 2;
        if (value % 2 === 0) return 4;
        return 8;
    }

    /**
     * Abstract interpretation for addition
     * Table from tlbc.cpp lines 1212-1220
     */
    private abstractAdd(x: number, y: number): number {
        const baseTable: number[][] = [
            [1, 2, 4, 8], // 0 + {0, 1, even>=2, odd>=3}
            [2, 4, 8, 12], // 1 + {0, 1, even>=2, odd>=3}
            [4, 8, 12, 12], // even>=2 + {0, 1, even>=2, odd>=3}
            [8, 12, 12, 12], // odd>=3 + {0, 1, even>=2, odd>=3}
        ];
        let result = 0;
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                if (x & (1 << i) && y & (1 << j)) {
                    result |= baseTable[i][j];
                }
            }
        }
        return result;
    }

    /**
     * Abstract interpretation for multiplication
     * Table from tlbc.cpp lines 1224-1232
     */
    private abstractMul(x: number, y: number): number {
        const baseTable: number[][] = [
            [1, 1, 1, 1], // 0 * anything = 0
            [1, 2, 4, 8], // 1 * {0, 1, even>=2, odd>=3}
            [1, 4, 12, 12], // even>=2 * {0, 1, even>=2, odd>=3}
            [1, 8, 12, 12], // odd>=3 * {0, 1, even>=2, odd>=3}
        ];
        let result = 0;
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                if (x & (1 << i) && y & (1 << j)) {
                    result |= baseTable[i][j];
                }
            }
        }
        return result;
    }

    /**
     * Abstract interpretation for get bit operation
     * Table from tlbc.cpp lines 1236-1244
     */
    private abstractGetBit(x: number, y: number): number {
        const baseTable: number[][] = [
            [1, 1, 1, 1], // getbit(0, anything) = 0
            [2, 1, 3, 3], // getbit(1, {0, 1, ?, ?})
            [1, 3, 3, 3], // getbit(even>=2, {0, 1, ?, ?})
            [2, 3, 3, 3], // getbit(odd>=3, {0, 1, ?, ?})
        ];
        let result = 0;
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                if (x & (1 << i) && y & (1 << j)) {
                    result |= baseTable[i][j];
                }
            }
        }
        return result;
    }

    unpack(): { minBits: number; minRefs: number; maxBits: number; maxRefs: number } {
        return {
            minBits: 0,
            minRefs: 0,
            maxBits: 0,
            maxRefs: 0,
        };
    }

    pack(value: { minBits: number; minRefs: number; maxBits: number; maxRefs: number }): bigint {
        return (BigInt(value.minBits * 0x100 + value.minRefs) << 32n) + BigInt(value.maxBits * 0x100 + value.maxRefs);
    }

    isPossible(): boolean {
        return true;
    }

    /**
     * Compute size based on reference implementation (compute_size in tlbc.cpp)
     */
    computeSize(): Size {
        // isNat means it's a natural number expression, not a type
        // But isNatSubtype means it's a type that produces nat (like ##, #<=, etc.)
        if (this.isNat && !this.isNatSubtype) {
            return new Size(0n);
        }
        switch (this.tp) {
            case TypeExprType.Type:
                return new Size(0n);
            case TypeExprType.Param:
                return Size.anySize(); // any size possible for type parameters
            case TypeExprType.Ref: {
                if (this.args.length >= 1) {
                    const innerSize = this.args[0].computeSize();
                    return innerSize.isPossible() ? new Size(Size.OneRef) : new Size(Size.Impossible);
                }
                return new Size(Size.Impossible);
            }
            case TypeExprType.CondType: {
                if (this.args.length >= 2) {
                    const z = this.args[0].abstractInterpretNat();
                    if (!(z & ~1)) {
                        // always 0
                        return new Size(0n);
                    } else {
                        let t = this.args[1].computeSize();
                        if (z & 1) {
                            t = t.clearMin();
                        }
                        return t;
                    }
                }
                return new Size(Size.Impossible);
            }
            case TypeExprType.Tuple: {
                if (this.args.length >= 2) {
                    const z = this.args[0].abstractInterpretNat();
                    if (!(z & ~1)) {
                        // always 0
                        return new Size(0n);
                    } else {
                        let t = this.args[1].computeSize();
                        if (this.args[0].tp === TypeExprType.IntConst) {
                            t = t.repeat(this.args[0].value);
                            return t;
                        }
                        if (z & 1) {
                            // zero repetition count possible
                            t = t.clearMin();
                        }
                        if (z & 12) {
                            // may be repeated more than once
                            const n = z & 1 ? 0 : z & 2 ? 1 : 2; // minimal value of repetition count
                            t = t.repeatAtLeast(n); // repetition count >= n
                        }
                        return t;
                    }
                }
                return new Size(Size.Impossible);
            }
            case TypeExprType.MulConst: {
                // Multiplication: n * Type (e.g., n * Bit)
                // This is similar to Tuple, but with value as multiplier
                if (this.args.length >= 1) {
                    // For MulConst, value is the constant multiplier
                    if (this.value > 0) {
                        let t = this.args[0].computeSize();
                        t = t.repeat(this.value);
                        return t;
                    }
                    // If value is 0 or not set, check if first arg is nat
                    const z = this.args[0].abstractInterpretNat();
                    if (!(z & ~1)) {
                        // always 0
                        return new Size(0n);
                    } else {
                        // For variable multiplier, use abstract interpretation
                        let t = this.args.length >= 2 ? this.args[1].computeSize() : Size.anySize();
                        if (z & 1) {
                            // zero repetition count possible
                            t = t.clearMin();
                        }
                        if (z & 12) {
                            // may be repeated more than once
                            const n = z & 1 ? 0 : z & 2 ? 1 : 2; // minimal value of repetition count
                            t = t.repeatAtLeast(n); // repetition count >= n
                        }
                        return t;
                    }
                }
                return Size.anySize();
            }
            case TypeExprType.Apply: {
                if (this.typeApplied) {
                    // Check for built-in types with constant arguments
                    if (this.args.length === 1 && this.args[0].tp === TypeExprType.IntConst) {
                        const n = this.args[0].value;
                        const typeName = symbolMap.getName(this.typeApplied.typeNameId);
                        if (typeName === '##') {
                            return Size.fixedSize(Math.min(n, 2047));
                        } else if (typeName === '#<=') {
                            // #<= n: size is ceil(log2(n+1))
                            if (n === 0) {
                                return Size.fixedSize(2047);
                            }
                            const bits = 32 - Math.clz32(n);
                            return Size.fixedSize(bits);
                        } else if (typeName === '#<') {
                            // #< n: size is ceil(log2(n))
                            if (n <= 1) {
                                return Size.fixedSize(2047);
                            }
                            const bits = 32 - Math.clz32(n - 1);
                            return Size.fixedSize(bits);
                        } else if (typeName === 'int' || typeName === 'uint' || typeName === 'bits') {
                            return Size.fixedSize(Math.min(n, 2047));
                        }
                    }
                    // For other cases, use the type's size
                    return this.typeApplied.size;
                }
                return Size.anySize();
            }
            default:
                return Size.anySize();
        }
    }

    /**
     * Compute "any bits" flag based on reference implementation (compute_any_bits in tlbc.cpp)
     */
    computeAnyBits(): boolean {
        if (this.isNat) {
            return true;
        }
        switch (this.tp) {
            case TypeExprType.Type:
                return true;
            case TypeExprType.Param:
                return false;
            case TypeExprType.Ref:
                return true;
            case TypeExprType.Tuple:
            case TypeExprType.CondType: {
                if (this.args.length === 2) {
                    const z = this.args[0].abstractInterpretNat();
                    if (!(z & ~1)) {
                        return true; // always 0
                    } else {
                        return this.args[1].computeAnyBits();
                    }
                }
                return false;
            }
            case TypeExprType.Apply: {
                if (this.typeApplied) {
                    if (this.args.length === 1 && this.args[0].tp === TypeExprType.IntConst) {
                        const n = this.args[0].value;
                        const typeName = symbolMap.getName(this.typeApplied.typeNameId);
                        if (typeName === '#<=') {
                            // #<= n: any_bits if n is power of 2 minus 1
                            return !(n & (n + 1));
                        } else if (typeName === '#<') {
                            // #< n: any_bits if n is power of 2
                            return !(n & (n - 1));
                        }
                    }
                    return this.typeApplied.anyBits;
                }
                return false;
            }
            default:
                return false;
        }
    }
}
