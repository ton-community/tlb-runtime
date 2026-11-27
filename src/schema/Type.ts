import { Size } from './Size';
import { Constructor } from './Constructor';
import { BitPrefixCollection } from './BitPrefixCollection';
import { AdmissibilityInfo } from './AdmissibilityInfo';
import { BinTrie } from './BinTrie';
import { symbolMap } from './SymbolMap';

export const Undefined = -1;

// TODO may be use or not
export enum TypeKind {
    Nat,
    SignedInteger,
    UnsignedInteger,
}

export enum TypeInteger {
    None = 0,
    Signed = -1,
    Unsigned = 1,
}

export enum TypeArgFlags {
    IsType = 1,
    IsNat = 2,
    IsPos = 4,
    IsNeg = 8,
    NonConst = 16,
}

export interface TypeProp {
    typeNameId: number;
    typeIdx: number;
    parentTypeIdx: number;
    constrNum: number;
    arity: number;
    used: number;
    lastDeclared: number;
    producesNat: boolean;
    isFinal: boolean;
    isBuiltin: boolean;
    isEnum: boolean;
    isSimpleEnum: boolean;
    isSpecial: boolean;
    isPfxDeterm: boolean;
    isParamDeterm: boolean;
    isConstParamDeterm: boolean;
    isConstParamPfxDeterm: boolean;
    isParamPfxDeterm: boolean;
    isDeterm: boolean;
    hasFixedSize: boolean;
    anyBits: boolean;
    isAuto: boolean;
    isAnon: boolean;
    isUnit: boolean;
    isBool: boolean;
    isInteger: number;
    usefulDepth: number;
    constParamIdx: number;
    conflict1: number;
    conflict2: number;
    size: Size;
    constructors: Constructor[];
    args: number[];
    beginsWith: BitPrefixCollection;
    admissibleParams: AdmissibilityInfo;
    csTrie: BinTrie | null;
}

export class Type {
    name: string;
    typeNameId: number;
    typeIdx: number;
    parentTypeIdx: number;
    constrNum: number;
    arity: number;
    used: number;
    lastDeclared: number;
    producesNat: boolean;
    isFinal: boolean;
    isBuiltin: boolean;
    isEnum: boolean;
    isSimpleEnum: boolean;
    isSpecial: boolean;
    isPfxDeterm: boolean;
    isParamDeterm: boolean;
    isConstParamDeterm: boolean;
    isConstParamPfxDeterm: boolean;
    isParamPfxDeterm: boolean;
    isDeterm: boolean;
    hasFixedSize: boolean;
    anyBits: boolean;
    isAuto: boolean;
    isAnon: boolean;
    isUnit: boolean;
    isBool: boolean;
    isInteger: number;
    usefulDepth: number;
    constParamIdx: number;
    conflict1: number;
    conflict2: number;
    size: Size;
    constructors: Constructor[];
    args: number[];
    beginsWith: BitPrefixCollection;
    admissibleParams: AdmissibilityInfo;
    csTrie: BinTrie | null;

    private constructor(name: string, prop: Partial<TypeProp>) {
        this.name = name;
        this.typeNameId = prop.typeNameId ?? 0;
        this.typeIdx = prop.typeIdx ?? 0;
        this.parentTypeIdx = prop.parentTypeIdx ?? Undefined;
        this.constrNum = prop.constrNum ?? 0;
        this.arity = prop.arity ?? Undefined;
        this.used = prop.used ?? 0;
        this.lastDeclared = prop.lastDeclared ?? 0;
        this.producesNat = prop.producesNat ?? false;
        this.isFinal = prop.isFinal ?? false;
        this.isBuiltin = prop.isBuiltin ?? prop.isFinal ?? false;
        this.isEnum = prop.isEnum ?? !(prop.isFinal ?? false);
        this.isSimpleEnum = prop.isSimpleEnum ?? !(prop.isFinal ?? false);
        this.isSpecial = prop.isSpecial ?? false;
        this.isPfxDeterm = prop.isPfxDeterm ?? false;
        this.isParamDeterm = prop.isParamDeterm ?? false;
        this.isConstParamDeterm = prop.isConstParamDeterm ?? false;
        this.isConstParamPfxDeterm = prop.isConstParamPfxDeterm ?? false;
        this.isParamPfxDeterm = prop.isParamPfxDeterm ?? false;
        this.isDeterm = prop.isDeterm ?? false;
        this.hasFixedSize = prop.hasFixedSize ?? false;
        this.anyBits = prop.anyBits ?? false;
        this.isAuto = prop.isAuto ?? false;
        this.isAnon = prop.isAnon ?? false;
        this.isUnit = prop.isUnit ?? false;
        this.isBool = prop.isBool ?? false;
        this.isInteger = prop.producesNat ? TypeInteger.Unsigned : (prop.isInteger ?? TypeInteger.None);
        this.usefulDepth = prop.usefulDepth ?? Undefined;
        this.constParamIdx = prop.constParamIdx ?? Undefined;
        this.conflict1 = prop.conflict1 ?? Undefined;
        this.conflict2 = prop.conflict2 ?? Undefined;
        this.size = prop.size ?? new Size(Size.Impossible);
        this.constructors = prop.constructors ?? [];
        this.args = prop.args ?? [];
        this.beginsWith = prop.beginsWith ?? new BitPrefixCollection();
        this.admissibleParams = prop.admissibleParams ?? new AdmissibilityInfo();
        this.csTrie = prop.csTrie ?? null;
    }

    static create(
        name: string,
        typeIdx: number,
        producesNat: boolean = false,
        arity: number = Undefined,
        isFinal: boolean = false,
        nonempty: boolean = false,
        parentTypeIdx: number = Undefined,
        isInteger: number = TypeInteger.None,
    ): Type {
        const typeNameId = symbolMap.lookupAdd(name);
        if (!name.length || !typeNameId) {
            throw new Error(`Invalid type name: ${name}`);
        }
        const type = new Type(name, {
            typeNameId,
            typeIdx,
            parentTypeIdx,
            constrNum: 0,
            arity: arity >= 0 ? arity : 0,
            used: 0,
            lastDeclared: 0,
            producesNat,
            isFinal,
            isBuiltin: isFinal,
            isEnum: !isFinal,
            isSimpleEnum: !isFinal,
            isSpecial: false,
            isPfxDeterm: false,
            isParamDeterm: false,
            isConstParamDeterm: false,
            isConstParamPfxDeterm: false,
            isParamPfxDeterm: false,
            isDeterm: false,
            hasFixedSize: false,
            anyBits: false,
            isAuto: false,
            isAnon: false,
            isUnit: false,
            isBool: false,
            isInteger,
            usefulDepth: Undefined,
            constParamIdx: Undefined,
            conflict1: Undefined,
            conflict2: Undefined,
            size: new Size(Size.Impossible),
            constructors: [],
            args: [],
            beginsWith: new BitPrefixCollection(),
            admissibleParams: new AdmissibilityInfo(),
            csTrie: null,
        });

        if (nonempty) {
            type.beginsWith.all();
        }

        return type;
    }

    static builtinType(
        name: string = '',
        typeId: number,
        args: string[],
        producesNat: boolean,
        size: number = Undefined,
        minSize: number = Undefined,
        anyBits: boolean = false,
        isInteger: number = TypeInteger.None,
    ): Type {
        const arity = args.length;
        const type = Type.create(name, typeId, producesNat, arity, true, true, Undefined, isInteger);

        type.isBuiltin = true;
        type.isEnum = false;
        type.isSimpleEnum = false;
        type.isSpecial = false;
        type.anyBits = anyBits;
        type.setupSize(size, minSize);

        const f = name !== '#' ? TypeArgFlags.IsPos : 0;
        for (let i = 0; i < arity; i++) {
            type.args[i] = f | (args[i] === '#' ? TypeArgFlags.IsNat : TypeArgFlags.IsType);
        }

        return type;
    }

    setupSize(max: number = Undefined, min: number = Undefined): void {
        if (max < 0) {
            this.size = Size.anySize();
        } else if (min >= 0 && min !== max) {
            this.size = Size.sizeRange(min, max);
        } else {
            this.size = Size.fixedSize(max);
            this.hasFixedSize = true;
        }
    }

    findConstructorByName(constrName: number): Constructor | undefined {
        return this.constructors.find((c) => c.constrName === constrName);
    }

    /**
     * Get the maximum tag bits among all constructors.
     * Used for constructor detection (prefix-based detection).
     */
    get prefixSize(): number {
        let maxTagBits = 0;
        for (const constructor of this.constructors) {
            if (constructor.tagBits > maxTagBits) {
                maxTagBits = constructor.tagBits;
            }
        }
        return maxTagBits;
    }

    /**
     * Get type flags as string array (UNIT, BOOL, SIMPLE ENUM).
     */
    get typeFlags(): string[] {
        const flags: string[] = [];
        if (this.isUnit) {
            flags.push('(UNIT)');
        }
        if (this.isBool) {
            flags.push('(BOOL)');
        }
        if (this.isSimpleEnum) {
            flags.push('(SIMPLE ENUM)');
        }
        return flags;
    }

    /**
     * Get size display string with flags.
     */
    get sizeDisplay(): string {
        const sizeStr = this.size.toString();
        const parts: string[] = [`type size ${sizeStr}`];

        if (this.hasFixedSize) {
            parts.push('(fixed)');
        }
        // (any bits) is shown when all bit patterns are valid (anyBits=true and prefix is {*})
        if (this.anyBits && this.beginsWith.isAll()) {
            parts.push('(any bits)');
        }

        return parts.join(' ');
    }

    toString(): string {
        const out: string[] = [];
        const name = symbolMap.getName(this.typeNameId) || `type#${this.typeNameId}`;

        out.push(`type #${this.typeIdx}: \`${name}\`, arity ${this.arity}, ${this.constrNum} constructors`);

        for (const constructor of this.constructors) {
            out.push(constructor.toString());
        }

        // Type flags
        for (const flag of this.typeFlags) {
            out.push(`  ${flag}`);
        }

        // Constructor detection
        if (this.constrNum > 1) {
            const pfxSize = this.prefixSize;
            if (pfxSize > 0) {
                out.push(`  constructor detection: PFX(${pfxSize}) `);
            } else if (this.isParamDeterm) {
                out.push(`  constructor detection: PARAM `);
            }
        }

        out.push(`  ${this.sizeDisplay}`);
        out.push(`  type begins with ${this.beginsWith.toString()}`);

        // Type admissibility if arity > 0 and not all-set
        if (this.arity > 0 && !this.admissibleParams.isSetAll()) {
            out.push(`  type admissibility ${this.admissibleParams.toString()}`);
        }

        out.push('');

        return out.join('\n');
    }
}
