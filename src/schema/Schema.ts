import {
    ast,
    Declaration,
    FieldAnonymousDef,
    FieldAnonExpr,
    BuiltinOneArgExpr,
    CellRefExpr,
    CombinatorExpr,
    CompareExpr,
    CondExpr,
    FieldBuiltinDef,
    FieldCurlyExprDef,
    MathExpr,
    NameExpr,
    NegateExpr,
    NumberExpr,
    walk,
} from 'tlb-parser-v2';

import { Result } from '../Result';
import { TLBSchemaError } from '../errors';
import { SymbolMap } from './SymbolMap';
import { Type, TypeInteger, Undefined } from './Type';
import { SrcLocation, SrcLocationProp } from './SrcLocation';
import { Constructor } from './Constructor';
import { Size } from './Size';
import { TypeExpr, TypeExprType } from './TypeExpr';
import { AdmissibilityInfo } from './AdmissibilityInfo';
import { BitPrefixCollection } from './BitPrefixCollection';
import { Field } from './Field';
import { constructorTag } from './constructorTag';

interface FieldDef {
    constructor: { name: string };
    name?: string | null;
    type?: string;
    expr?: unknown;
    locations?: Partial<SrcLocationProp>;
    fields?: FieldDef[];
    isRef?: boolean;
}

export class Schema {
    private readonly symbols = new SymbolMap();
    builtinTypesNum: number = 0;
    types: Type[] = [];
    private constExprCounter: number = 0;
    private constExprMap: Map<string, number> = new Map();
    private nextAnonymousTypeIdx: number = 0;
    private declarationText = new WeakMap<Constructor, string>();
    private tlbTypesCache?: ReadonlyMap<string, import('../types').TLBType>;

    constructor(readonly lastTypeName?: string) {
        this.defineBuiltins();
    }

    static from(code: string): Result<Schema> {
        try {
            const source = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\r\n]/g, ' '));
            const tree = ast(code);
            const lineStarts = [0];
            for (let i = 0; i < source.length; i++) {
                if (source[i] === '\n') lineStarts.push(i + 1);
            }
            const schema = new Schema(tree.declarations.at(-1)?.combinator.name);

            // Build map of type definitions
            const declarationMap = new Map<string, Declaration>();
            for (const declaration of tree.declarations) {
                const name = declaration.combinator.name;
                if (!declarationMap.has(name)) {
                    declarationMap.set(name, declaration);
                }
            }

            // Older public APIs accept these standard types without their declarations.
            for (const name of [
                'Bool',
                'Coins',
                'Grams',
                'VarUInteger',
                'MsgAddress',
                'MsgAddressInt',
                'MsgAddressExt',
                'HashmapE',
            ]) {
                if (!declarationMap.has(name) && new RegExp('\\b' + name + '\\b').test(source)) {
                    schema.defineBuiltinType(
                        name,
                        name === 'HashmapE' ? ['#', 'Type'] : name === 'VarUInteger' ? ['#'] : [],
                        false,
                    );
                }
            }

            const visited = new Set<string>();
            const registering = new Set<string>();

            const getDeps = (decl: Declaration): string[] => {
                const deps = new Set<string>();
                if (decl.fields) {
                    for (const field of decl.fields) {
                        if ('expr' in field) {
                            Schema.extractTypesFromExpr(field.expr, deps);
                        }
                    }
                }
                return Array.from(deps);
            };

            const register = (name: string) => {
                if (schema.findTypeByName(name)) return;
                if (visited.has(name)) return;
                if (registering.has(name)) return;

                registering.add(name);

                const decl = declarationMap.get(name);
                if (decl) {
                    const deps = getDeps(decl);
                    for (const dep of deps) {
                        register(dep);
                    }
                    schema.addTypeStub(decl);
                }

                registering.delete(name);
                visited.add(name);
            };

            // First pass: Register type stubs in dependency order
            // Dependencies are registered before the types that use them
            for (const declaration of tree.declarations) {
                register(declaration.combinator.name);
                // Register anonymous types immediately after registering type stubs
                // This ensures anonymous types get their indices in declaration order
                schema.registerAnonymousTypes(declaration);
            }

            // Second pass: define constructors and fields
            // lastDeclared will be set in defineUserType for each type on first constructor
            schema.nextAnonymousTypeIdx = schema.builtinTypesNum; // Reset to first user type index
            for (const declaration of tree.declarations) {
                const { line, column } = declaration.locations;
                const start = lineStarts[line - 1] + column - 1;
                schema.defineUserType(declaration, source.slice(start, source.indexOf(';', start) + 1));
            }

            // Recalculate sizes to handle mutual recursion
            schema.recalculateSizes();
            schema.getTLBTypes();

            return {
                success: true,
                value: schema,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: new TLBSchemaError(`Schema parsing failed: ${errorMessage}`) };
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static extractTypesFromExpr(expr: any, deps: Set<string>) {
        if (!expr) return;
        if (expr instanceof CombinatorExpr) {
            if (expr.name) deps.add(expr.name);
            if (expr.args) {
                for (const arg of expr.args) Schema.extractTypesFromExpr(arg, deps);
            }
        } else if (expr instanceof CellRefExpr) {
            Schema.extractTypesFromExpr(expr.expr, deps);
        } else if (expr instanceof NameExpr) {
            if (expr.name) deps.add(expr.name);
        } else if (expr instanceof MathExpr || expr instanceof CompareExpr) {
            Schema.extractTypesFromExpr(expr.left, deps);
            Schema.extractTypesFromExpr(expr.right, deps);
        } else if (expr instanceof NegateExpr) {
            Schema.extractTypesFromExpr(expr.expr, deps);
        }
    }

    recalculateSizes(): void {
        // Fixpoint iteration for sizes - recalculate until stable
        let changed = true;
        // Limit iterations to prevent infinite loops (though sizes should be monotonic or stabilize)
        let iter = 0;
        while (changed && iter < 100) {
            changed = false;
            for (const type of this.userTypes) {
                for (const constructor of type.constructors) {
                    // Recalculate constructor size
                    const oldSize = constructor.size.size;
                    constructor.size = Size.fixedSize(constructor.tagBits);
                    constructor.hasFixedSize = true;

                    for (const field of constructor.fields) {
                        if (field.implicit || field.constraint) {
                            continue;
                        }
                        const fieldSize = field.type.computeSize();
                        constructor.size.addAssign(fieldSize);
                        if (!fieldSize.isFixed()) {
                            constructor.hasFixedSize = false;
                        }
                    }

                    if (constructor.size.size !== oldSize) {
                        changed = true;
                    }
                }

                // Recalculate type size from constructors
                const oldTypeSize = type.size.size;
                if (type.constructors.length > 0) {
                    // Clone the first constructor's size properly
                    type.size = new Size(type.constructors[0].size.size, true);
                    for (let i = 1; i < type.constructors.length; i++) {
                        type.size.orAssign(type.constructors[i].size);
                    }
                    type.hasFixedSize = type.size.isFixed();
                }

                if (type.size.size !== oldTypeSize) {
                    changed = true;
                }
            }
            iter++;
        }

        // Recalculate anyBits flags
        changed = true;
        iter = 0;
        while (changed && iter < 100) {
            changed = false;
            for (const type of this.userTypes) {
                for (const constructor of type.constructors) {
                    let res = true;
                    for (const field of constructor.fields) {
                        if (!field.implicit && !field.constraint) {
                            res = res && field.type.computeAnyBits();
                        }
                    }
                    if (res !== constructor.anyBits) {
                        constructor.anyBits = res;
                        changed = true;
                    }
                }

                // Type anyBits is: beginsWith.isAll() AND all constructors have anyBits
                let res = type.beginsWith.isAll();
                for (const constructor of type.constructors) {
                    res = res && constructor.anyBits;
                }
                if (res !== type.anyBits) {
                    type.anyBits = res;
                    changed = true;
                }
            }
            iter++;
        }

        // Calculate admissibility for parametric types
        this.calculateAdmissibility();
    }

    /**
     * Calculate admissibility info for types with parameters
     * This determines which parameter values are valid for each constructor
     */
    private calculateAdmissibility(): void {
        for (const type of this.userTypes) {
            if (type.arity === 0 || type.constructors.length === 0) {
                continue;
            }

            // Reset type admissibility
            type.admissibleParams.clearAll();

            // Check if all constructors have empty prefix (all begin with {*})
            let allEmpty = true;
            for (const constructor of type.constructors) {
                if (!constructor.beginsWith.isAll()) {
                    allEmpty = false;
                    break;
                }
            }

            for (const constructor of type.constructors) {
                // Reset constructor admissibility
                constructor.admissibleParams.clearAll();

                // Get the first type parameter expression
                // Only calculate admissibility for non-negated first parameters
                if (constructor.params.length > 0) {
                    const firstParam = constructor.params[0];

                    // Skip negated parameters (they indicate OUTPUT values, not input constraints)
                    if (!firstParam.negated) {
                        // Calculate abstract interpretation of the first parameter
                        const admissPattern = firstParam.abstractInterpretNat();

                        // Set admissibility based on pattern
                        // Pattern bits: 0x1=can be 0, 0x2=can be 1, 0x4=can be even>=2, 0x8=can be odd>=3
                        constructor.admissibleParams.dimension = 0;
                        constructor.admissibleParams.info = [
                            !!(admissPattern & 0x1), // Can be 0
                            !!(admissPattern & 0x2), // Can be 1
                            !!(admissPattern & 0x4), // Can be even >= 2
                            !!(admissPattern & 0x8), // Can be odd >= 3
                        ];
                        constructor.admissibleParams.dimension = 1; // 1 dimension = 4 entries
                    }
                }

                // Merge into type admissibility
                type.admissibleParams.orAssign(constructor.admissibleParams);
            }

            // Set isParamDeterm if all constructors have empty prefix but different admissibility
            if (allEmpty && type.constructors.length > 1) {
                // Check if constructors have disjoint admissibility
                let canDistinguish = true;
                for (let i = 0; i < type.constructors.length && canDistinguish; i++) {
                    for (let j = i + 1; j < type.constructors.length && canDistinguish; j++) {
                        if (
                            type.constructors[i].admissibleParams.conflictsWith(type.constructors[j].admissibleParams)
                        ) {
                            // There's overlap - but this is still valid for PARAM detection
                            // as long as there's some parameter-based distinction possible
                        }
                    }
                }
                // If all begin with {*}, detection must be by parameter
                type.isParamDeterm = true;
            }
        }
    }

    private lastDeclaredCounter: number = 0;

    addTypeStub(declaration: Declaration): void {
        const name = declaration.combinator.name;
        if (name.length === 0 || !/[A-Z]/.test(name[0])) {
            return;
        }
        const existingType = this.findTypeByName(name);
        if (!existingType) {
            const typeIdx = this.types.length;
            const arity = declaration.combinator.args.length;
            const type = Type.create(this.symbols, name, typeIdx, false, arity, false, false);
            this.types.push(type);
            this.symbols.lookupAdd(name);
        }
    }

    /**
     * Register anonymous types from all declarations.
     * Must be called for EVERY declaration (not just unique types) because
     * different constructors of the same type can have different anonymous fields.
     */
    registerAnonymousTypes(declaration: Declaration): void {
        for (const field of declaration.fields) {
            for (const node of walk(field)) {
                if (!(node instanceof FieldAnonymousDef || node instanceof FieldAnonExpr)) continue;
                const typeIdx = this.types.length;
                const type = Type.create(this.symbols, `TYPE_${typeIdx}`, typeIdx, false, 0, false, true);
                type.isAnon = true;
                this.types.push(type);
            }
        }
    }

    get getBuiltinTypes(): Type[] {
        return this.types.slice(0, this.builtinTypesNum);
    }

    get userTypes(): Type[] {
        return this.types.slice(this.builtinTypesNum);
    }

    isBuiltinType(type: Type): boolean {
        return type.typeIdx < this.builtinTypesNum;
    }

    findTypeByName(name: string | number): Type | undefined {
        if (name === 'Type') {
            this.symbols.lookupAdd('Type'); // Ensure symbol is registered
            return Type.create(this.symbols, 'Type', -1, false, 0, false, false); // Dummy type, not stored in types array
        }
        const nameId = typeof name === 'string' ? this.symbols.lookup(name) : name;
        if (!nameId) return undefined;
        return this.types.find((t) => t.typeNameId === nameId);
    }

    findTypeById(typeNameId: number): Type | undefined {
        return this.types.find((t) => t.typeNameId === typeNameId);
    }

    defineUserType(declaration: Declaration, source = ''): Type {
        const name = declaration.combinator.name;
        if (name.length === 0 || !/[A-Z]/.test(name[0])) {
            const error = `implicitly defined type \`${name}\` must begin with an uppercase letter`;
            if (declaration.locations) {
                throw new Error(`${declaration.locations.line}:${declaration.locations.column}: ${error}`);
            }
            throw new Error(error);
        }

        const arity = declaration.combinator.args.length;

        const type = this.findTypeByName(name);

        // With two-pass loading, type should always exist
        if (!type) {
            throw new Error(`Type ${name} not found in schema (internal error)`);
        }

        const isFirstConstructor = type.constructors.length === 0;

        // Parse constructor from declaration
        if (declaration.constructorDef && declaration.fields) {
            const constrName = declaration.constructorDef.name || '_';
            const constrNameIdx = constrName === '_' ? 0 : this.symbols.lookupAdd(constrName);

            // Parse tag if present
            let tag = 0n;
            let tagBits = 0;
            if (declaration.constructorDef.tag) {
                const tagStr = declaration.constructorDef.tag;
                if (tagStr.startsWith('$')) {
                    const binStr = tagStr.substring(1).replace(/_/g, '');
                    if (binStr === '') {
                        tag = 0n;
                        tagBits = 0;
                    } else {
                        tagBits = binStr.length;
                        // tag value parsing (simplified)
                        // In Schema.ts tag is just BigInt.
                        // We need to set bits.
                        tag = 0n;
                        for (let i = 0; i < tagBits; i++) {
                            tag = (tag << 1n) | (binStr[i] === '1' ? 1n : 0n);
                        }
                        // Add marker bit for tag?
                        // Schema code used 1n << 63n for default.
                        // Constructor.ts toString checks tagBits.
                        // If tagBits > 0, it expects tag value.
                        // If tagBits == 0, tag is ignored?
                    }
                } else if (tagStr.startsWith('#')) {
                    // Hex tag
                    const hexStr = tagStr.substring(1).replace(/_/g, '');
                    if (hexStr === '') {
                        tag = 0n;
                        tagBits = 0;
                    } else {
                        tagBits = hexStr.length * 4;
                        tag = BigInt(`0x${hexStr}`);
                    }
                    if (hexStr.length && tagStr.endsWith('_')) {
                        if (tag === 0n) throw new TLBSchemaError('A partial hex tag needs a terminator bit');
                        while ((tag & 1n) === 0n) {
                            tag >>= 1n;
                            tagBits--;
                        }
                        tag >>= 1n;
                        tagBits--;
                    }
                }
            }

            if (!declaration.constructorDef.tag && constrName !== '_') {
                tag = BigInt(constructorTag(declaration));
                tagBits = 32;
            }

            // Create constructor
            const constructor = new Constructor(this.symbols, {
                constrName: constrNameIdx,
                typeName: type.typeNameId,
                typeDefined: type,
                where: SrcLocation.from(declaration.locations),
                tag: tag,
                tagBits: tagBits,
                fieldsNum: declaration.fields.length,
                typeArity: arity,
                isFwd: declaration.fields.length === 0, // Simple forwarder if no fields
                isEnum: false,
                isSimpleEnum: false,
                isSpecial: false,
                hasFixedSize: false,
                anyBits: false,
                size: new Size(Size.Impossible),
                beginsWith: new BitPrefixCollection(),
                fields: [],
                params: [],
                paramNegated: [],
                paramConstVal: [],
                admissibleParams: new AdmissibilityInfo(),
            });

            this.declarationText.set(constructor, source);
            const params = new Map<number, { idx: number; isNat: boolean }>();

            // Parse fields
            for (let i = 0; i < declaration.fields.length; i++) {
                const fieldDecl = declaration.fields[i];
                // Check if field has name (FieldNamedDef)
                const fieldName = 'name' in fieldDecl ? (fieldDecl.name as string) : '';
                const fieldNameIdx = fieldName ? this.symbols.lookupAdd(fieldName) : 0;

                // Parse field type expression
                let fieldTypeExpr: TypeExpr;
                if (fieldDecl instanceof FieldAnonymousDef) {
                    // Handle anonymous inline type definition (e.g., ^[$_ ... ] or [$_ ... ])
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const anonFieldDecl = fieldDecl as any;
                    const anonType = this.createAnonymousType(
                        anonFieldDecl.fields,
                        SrcLocation.from(anonFieldDecl.locations),
                        params,
                    );
                    const applyExpr = new TypeExpr(TypeExprType.Apply, anonType, [], 0, false, false);
                    if (anonFieldDecl.isRef) {
                        // Wrap in Ref for ^[...] syntax
                        fieldTypeExpr = this.registerConstExpr(new TypeExpr(TypeExprType.Ref, null, [applyExpr]));
                    } else {
                        fieldTypeExpr = this.registerConstExpr(applyExpr);
                    }
                } else if ('type' in fieldDecl && typeof fieldDecl.type === 'string') {
                    // FieldBuiltinDef (e.g. {X:Type} or {n:#})
                    if (fieldDecl.type === '#') {
                        // # is a builtin type - use Apply
                        const hashType = this.findTypeByName('#');
                        fieldTypeExpr = this.registerConstExpr(
                            new TypeExpr(
                                TypeExprType.Apply,
                                hashType,
                                [],
                                0,
                                true, // producesNat
                                true, // isNatSubtype
                            ),
                        );
                    } else if (fieldDecl.type === 'Type') {
                        // Type is a type
                        const typeType = this.findTypeByName('Type');
                        fieldTypeExpr = this.registerConstExpr(
                            new TypeExpr(TypeExprType.Apply, typeType, [], 0, false, false),
                        );
                    } else {
                        // Should not happen
                        fieldTypeExpr = new TypeExpr(TypeExprType.Type);
                    }
                } else {
                    fieldTypeExpr = this.parseTypeExpr(
                        'expr' in fieldDecl ? fieldDecl.expr : null,
                        SrcLocation.from('locations' in fieldDecl ? fieldDecl.locations : null),
                        params,
                    );
                }

                // Tuple is never isNatSubtype, even if the second argument is
                if (fieldTypeExpr.tp === TypeExprType.Tuple) {
                    fieldTypeExpr.isNatSubtype = false;
                }

                if (fieldNameIdx !== 0) {
                    params.set(fieldNameIdx, { idx: i, isNat: fieldTypeExpr.isNat || fieldTypeExpr.isNatSubtype });
                }

                // Detect implicit field
                // FieldBuiltinDef ({n:#}) and FieldCurlyExprDef ({...}) are implicit
                const isImplicit = fieldDecl instanceof FieldBuiltinDef || fieldDecl instanceof FieldCurlyExprDef;

                // FieldCurlyExprDef is a constraint (e.g., {n <= m} or {= n (~m + l)})
                // FieldBuiltinDef is a parameter definition (e.g., {n:#} or {X:Type})
                const isConstraint = fieldDecl instanceof FieldCurlyExprDef;

                const field = new Field(
                    this.symbols.getName(fieldNameIdx),
                    i,
                    fieldNameIdx,
                    fieldTypeExpr,
                    SrcLocation.from('locations' in fieldDecl ? fieldDecl.locations : null),
                    {
                        implicit: isImplicit,
                        known: false,
                        constraint: isConstraint,
                        used: false,
                        subrec: false,
                    },
                );

                constructor.fields.push(field);
            }

            // Parse combinator args for result type display
            if (declaration.combinator && declaration.combinator.args) {
                for (const arg of declaration.combinator.args) {
                    const argExpr = this.parseTypeExpr(
                        arg,
                        SrcLocation.from(declaration.combinator.locations || declaration.locations),
                        params,
                    );
                    constructor.params.push(argExpr);
                    // Track if param is negated
                    constructor.paramNegated.push(argExpr.negated);
                }
            }

            // Second pass: mark fields as 'used' if they are referenced by other fields
            for (const field of constructor.fields) {
                this.markUsedParams(field.type, constructor.fields);
            }

            // Initialize begins_with based on tag
            if (tagBits > 0) {
                // Compute the prefix: tag value shifted left, with a marker bit
                const onePfx = (tag << (64n - BigInt(tagBits))) | (1n << (63n - BigInt(tagBits)));
                constructor.beginsWith = new BitPrefixCollection(onePfx);
                constructor.anyBits = false;
            } else {
                constructor.beginsWith.all();
                constructor.anyBits = true;
            }

            // Start with tag bits
            constructor.size = Size.fixedSize(tagBits);
            constructor.hasFixedSize = true;

            // Add fields size
            for (const field of constructor.fields) {
                if (field.implicit || field.constraint) {
                    continue; // No size contribution
                }

                // Use computeSize() method for proper size calculation
                const fieldSize = field.type.computeSize();
                constructor.size.addAssign(fieldSize);
                if (!fieldSize.isFixed()) {
                    constructor.hasFixedSize = false;
                }
            }
            // If empty fields and tag 0, size is 0 (fixed). initialized correctly.
            // If empty fields and tag > 0, size is tag (fixed). initialized correctly.

            if (constructor.fields.length === 0) {
                // For display/structure consistency
                // unit$_ logic handled implicit enum flag in Constructor.ts
            }
            // anyBits is true if the constructor's content (after tag) can be any bit pattern
            // For simple enums with just tags, anyBits is true
            // For types with variable-size fields, anyBits is already set to true above
            if (constructor.hasFixedSize) {
                // Check if all fields are implicit or have fixed sizes
                // If so, anyBits = true (any bit pattern is valid for the fixed size)
                constructor.anyBits = true;
            }

            // Check if simple forwarder
            // A constructor is a simple forwarder if:
            // - anonymous (constrName == 0)
            // - no tag (tagBits == 0)
            // - no type parameters (typeArity == 0)
            // - exactly one field
            // - and that field is not implicit and not constraint
            constructor.isFwd =
                constrNameIdx === 0 &&
                tagBits === 0 &&
                arity === 0 &&
                constructor.fields.length === 1 &&
                !constructor.fields[0].implicit &&
                !constructor.fields[0].constraint;

            // Calculate enum flags
            let explicitFields = 0;
            let trueParams = 0;
            // TODO: Calculate true_params from args logic (not fully simulated yet)
            // For now assume trueParams = 0 if no params?
            // constructor.typeArity is arity.
            // But true_params counts non-negated parameters?
            // In reference: true_params += !negated;
            // constructor.params is missing populating logic in Schema.ts yet?
            // "params" are populated in constructor?
            // defineUserType doesn't parse params yet?
            // "arity" comes from declaration.combinator.args.length
            // "type.args" is just an array of flags.

            // For Bit, arity=0, fields=1.
            for (const field of constructor.fields) {
                if (!field.implicit && !field.constraint) {
                    explicitFields++;
                }
            }
            constructor.isEnum = explicitFields === 0;
            // Simplified logic for simpleEnum: enum && no params?
            // If arity > 0, we need to check if params are "true parameters".
            // For now, if arity == 0, trueParams = 0.
            // If we assume all params are true params:
            trueParams = arity;
            // This is approximation.
            constructor.isSimpleEnum = constructor.isEnum && trueParams === 0;

            type.constructors.push(constructor);
            type.constrNum = type.constructors.length;

            // Update type enum flags
            type.isEnum = type.isEnum && constructor.isEnum;
            type.isSimpleEnum = type.isSimpleEnum && constructor.isSimpleEnum;

            if (isFirstConstructor) {
                // Set lastDeclared for this type (order of first declaration)
                this.lastDeclaredCounter++;
                type.lastDeclared = this.lastDeclaredCounter;

                // Initialize with first constructor
                type.size = new Size(constructor.size.size, true); // Clone with normalization
                type.hasFixedSize = constructor.hasFixedSize;
                type.anyBits = constructor.anyBits;
                type.beginsWith = new BitPrefixCollection();
                type.beginsWith.addAssign(constructor.beginsWith); // Clone by adding
            } else {
                // Merge with existing
                type.size.orAssign(constructor.size);
                type.beginsWith.addAssign(constructor.beginsWith);

                type.hasFixedSize = type.size.isFixed();
                type.anyBits = type.beginsWith.isAll();
            }
        } else {
            // User types have initial constructor count of 1
            type.constrNum = 1;
        }

        // Set args flags based on declaration arguments
        // TODO: Parse args from declaration.combinator.args to set proper flags
        // For now, initialize args array with appropriate size
        if (arity > 0) {
            type.args = new Array(arity).fill(0);
        }

        // Detect basic types (isUnit, isBool)
        if (type.arity === 0 && type.constrNum > 0 && type.hasFixedSize && type.anyBits && type.beginsWith.isAll()) {
            const minSize = type.size.minSize();
            if (minSize === 0) {
                type.isUnit = true;
            } else if (minSize === 0x100) {
                // isBool: 1-bit fixed size type with {*} prefix
                // Examples: Bool (2 constructors), Bit (1 constructor)
                type.isBool = true;
            }
        }

        return type;
    }

    get userTypesNum(): number {
        return this.types.length - this.builtinTypesNum;
    }

    get typesNum(): number {
        return this.types.length;
    }

    get userDefinedInfo(): string {
        const out: string[] = [];
        out.push(
            `${this.typesNum} types defined, out of them ${this.builtinTypesNum} built-in, ${this.userTypesNum} user-defined`,
        );

        // Collect all built-in types used in user-defined types
        const usedBuiltinTypes = new Set<Type>();
        const collectTypesFromExpr = (expr: TypeExpr): void => {
            if (expr.tp === TypeExprType.Apply && expr.typeApplied) {
                const type = expr.typeApplied;
                if (type.isBuiltin && type.typeIdx < this.builtinTypesNum) {
                    usedBuiltinTypes.add(type);
                }
            } else if (expr.tp === TypeExprType.Param && expr.isNat) {
                // For natural number parameter (#), find the built-in type '#'
                const natType = this.findTypeByName('#');
                if (natType && natType.isBuiltin) {
                    usedBuiltinTypes.add(natType);
                }
            }
            // Recursively process args
            for (const arg of expr.args) {
                collectTypesFromExpr(arg);
            }
        };

        // Collect types from all user-defined types
        for (let i = this.builtinTypesNum; i < this.typesNum; i++) {
            const type = this.types[i];
            for (const constructor of type.constructors) {
                for (const field of constructor.fields) {
                    collectTypesFromExpr(field.type);
                }
            }
        }

        // Output used built-in types
        // Find array index for each type and sort by index
        // Exclude '=', '<', '<=' comparison types from output
        const sortedUsedTypes = Array.from(usedBuiltinTypes)
            .filter((type) => {
                const name = this.symbols.getName(type.typeNameId);
                return name !== '=' && name !== '<' && name !== '<=';
            })
            .map((type) => ({ type, index: this.types.indexOf(type) }))
            .filter((item) => item.index >= 0)
            .sort((a, b) => a.index - b.index);

        for (const { type, index } of sortedUsedTypes) {
            const name = this.symbols.getName(type.typeNameId) || `type#${type.typeNameId}`;
            const parts: string[] = [];
            // Format: built-in type #0: `#`, arity 0; prefixes {*}; size =32
            parts.push(`built-in type #${index}: \`${name}\`, arity ${type.arity}`);
            parts.push(`prefixes ${type.beginsWith.toString()}`);
            const size = type.size.toString();
            if (size !== 'infty..infty') {
                const formattedSize = size.startsWith('=') ? ` ${size}` : ` ${size}`;
                parts.push(`size${formattedSize}`);
            }
            out.push(parts.join('; '));
        }

        // Output user types sorted by typeIdx (order of registration)
        const sortedUserTypes = [...this.userTypes].sort((a, b) => a.typeIdx - b.typeIdx);
        for (const type of sortedUserTypes) {
            out.push(type.toString());
        }

        out.push('****************');

        // Collect all constant expressions
        const constantExprs = new Map<number, TypeExpr>();
        const collectConstExprs = (expr: TypeExpr): void => {
            if (expr.isConstexpr > 0) {
                constantExprs.set(expr.isConstexpr, expr);
            }
            // Recursively process args
            for (const arg of expr.args) {
                collectConstExprs(arg);
            }
        };

        // Collect constant expressions from all user-defined types
        for (let i = this.builtinTypesNum; i < this.typesNum; i++) {
            const type = this.types[i];
            for (const constructor of type.constructors) {
                for (const field of constructor.fields) {
                    collectConstExprs(field.type);
                }
                // Also check constructor params
                for (const param of constructor.params) {
                    collectConstExprs(param);
                }
            }
        }

        // Output constant expressions sorted by index
        const sortedExprs = Array.from(constantExprs.entries()).sort((a, b) => a[0] - b[0]);

        out.push(`${sortedExprs.length} constant expressions:`);
        for (const [index, expr] of sortedExprs) {
            out.push(`expr #${index}: ${expr.toString()}`);
        }

        return out.join('\n') + '\n';
    }

    /**
     * Create an anonymous type for inline type definitions (e.g., ^[$_ ... ] or [$_ ... ])
     * Returns the created Type which can then be referenced.
     */

    private createAnonymousType(
        fields: FieldDef[],
        where: SrcLocation,
        parentParams?: Map<number, { idx: number; isNat: boolean }>,
    ): Type {
        // Find the next anonymous type that was pre-registered in first pass
        let type: Type | undefined;
        while (this.nextAnonymousTypeIdx < this.types.length) {
            const candidate = this.types[this.nextAnonymousTypeIdx];
            this.nextAnonymousTypeIdx++;
            if (candidate.isAnon && candidate.constructors.length === 0) {
                type = candidate;
                break;
            }
        }

        if (!type) {
            throw new Error('Internal error: no anonymous type stub available');
        }

        type.isEnum = true;
        type.isSimpleEnum = false;

        // Create anonymous constructor for this type
        const constructor = new Constructor(this.symbols, {
            constrName: this.symbols.lookupAdd('_'),
            typeName: type.typeNameId,
            typeDefined: type,
            where: where,
            tag: 0n,
            tagBits: 0,
            fieldsNum: fields.length,
            typeArity: 0,
            isFwd: false,
            isEnum: false,
            isSimpleEnum: false,
            isSpecial: false,
            hasFixedSize: true,
            anyBits: true,
            size: new Size(Size.Impossible),
            beginsWith: new BitPrefixCollection(),
            fields: [],
            params: [],
            paramNegated: [],
            paramConstVal: [],
            admissibleParams: new AdmissibilityInfo(),
        });

        // Parse fields using parent params for name resolution
        const localParams = new Map<number, { idx: number; isNat: boolean }>(parentParams);

        for (let i = 0; i < fields.length; i++) {
            const fieldDecl = fields[i];
            const fieldName = 'name' in fieldDecl ? (fieldDecl.name as string) : '';
            const fieldNameIdx = fieldName ? this.symbols.lookupAdd(fieldName) : 0;

            let fieldTypeExpr: TypeExpr;
            if (fieldDecl instanceof FieldAnonymousDef) {
                // Recursively handle nested anonymous types
                const anonType = this.createAnonymousType(
                    fieldDecl.fields || [],
                    SrcLocation.from(fieldDecl.locations),
                    localParams,
                );
                const applyExpr = new TypeExpr(TypeExprType.Apply, anonType, [], 0, false, false);
                if (fieldDecl.isRef) {
                    fieldTypeExpr = this.registerConstExpr(new TypeExpr(TypeExprType.Ref, null, [applyExpr]));
                } else {
                    fieldTypeExpr = this.registerConstExpr(applyExpr);
                }
            } else if ('type' in fieldDecl && typeof fieldDecl.type === 'string') {
                if (fieldDecl.type === '#') {
                    const hashType = this.findTypeByName('#');
                    fieldTypeExpr = this.registerConstExpr(
                        new TypeExpr(TypeExprType.Apply, hashType, [], 0, true, true),
                    );
                } else if (fieldDecl.type === 'Type') {
                    const typeType = this.findTypeByName('Type');
                    fieldTypeExpr = this.registerConstExpr(
                        new TypeExpr(TypeExprType.Apply, typeType, [], 0, false, false),
                    );
                } else {
                    fieldTypeExpr = new TypeExpr(TypeExprType.Type);
                }
            } else {
                fieldTypeExpr = this.parseTypeExpr(
                    'expr' in fieldDecl ? fieldDecl.expr : null,
                    SrcLocation.from('locations' in fieldDecl ? fieldDecl.locations : null),
                    localParams,
                );
            }

            if (fieldNameIdx !== 0) {
                localParams.set(fieldNameIdx, { idx: i, isNat: fieldTypeExpr.isNat || fieldTypeExpr.isNatSubtype });
            }

            const isImplicit = fieldDecl instanceof FieldBuiltinDef || fieldDecl instanceof FieldCurlyExprDef;
            const isConstraint = fieldDecl instanceof FieldCurlyExprDef;

            const field = new Field(
                this.symbols.getName(fieldNameIdx),
                i,
                fieldNameIdx,
                fieldTypeExpr,
                SrcLocation.from('locations' in fieldDecl ? fieldDecl.locations : null),
                {
                    implicit: isImplicit,
                    known: false,
                    constraint: isConstraint,
                    used: false,
                    subrec: false,
                },
            );

            constructor.fields.push(field);
        }

        // Mark used fields
        for (const field of constructor.fields) {
            this.markUsedParams(field.type, constructor.fields);
        }

        // Initialize begins_with
        constructor.beginsWith.all();
        constructor.anyBits = true;

        // Calculate size
        constructor.size = Size.fixedSize(0);
        constructor.hasFixedSize = true;
        for (const field of constructor.fields) {
            if (!field.implicit && !field.constraint) {
                const fieldSize = field.type.computeSize();
                constructor.size.addAssign(fieldSize);
                if (!fieldSize.isFixed()) {
                    constructor.hasFixedSize = false;
                }
            }
        }

        // Update type with constructor info
        type.constructors.push(constructor);
        type.size = new Size(constructor.size.size, true);
        type.hasFixedSize = constructor.hasFixedSize;
        type.anyBits = constructor.anyBits;
        type.beginsWith.all();
        type.isEnum = false;
        type.isSimpleEnum = false;

        return type;
    }

    /**
     * Parse TypeExpr from AST expression
     */

    private parseTypeExpr(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expr: any,
        where: SrcLocation,
        params?: Map<number, { idx: number; isNat: boolean }>,
    ): TypeExpr {
        if (!expr) {
            return new TypeExpr(TypeExprType.Type);
        }

        if (expr instanceof FieldAnonExpr) {
            const type = this.createAnonymousType(expr.fields, SrcLocation.from(expr.locations), params);
            const applied = new TypeExpr(TypeExprType.Apply, type);
            return this.registerConstExpr(expr.isRef ? new TypeExpr(TypeExprType.Ref, null, [applied]) : applied);
        }

        // Handle AST nodes from tlb-parser
        if (expr instanceof NumberExpr || ('num' in expr && !('kind' in expr))) {
            return this.registerConstExpr(new TypeExpr(TypeExprType.IntConst, null, [], expr.num, true, true));
        }

        if (expr instanceof BuiltinOneArgExpr || ('name' in expr && 'arg' in expr && !('kind' in expr))) {
            const typeName = expr.name as string;
            const appliedType = this.findTypeByName(typeName);
            if (appliedType) {
                const arg = this.parseTypeExpr(expr.arg, where, params);
                const applyExpr = new TypeExpr(
                    TypeExprType.Apply,
                    appliedType,
                    [arg],
                    0,
                    appliedType.producesNat,
                    appliedType.producesNat,
                );
                return this.registerConstExpr(applyExpr);
            }
        }

        if (expr instanceof CondExpr) {
            let condition = this.parseTypeExpr(expr.left, where, params);
            if (expr.dotExpr != null) {
                condition = new TypeExpr(TypeExprType.GetBit, null, [condition], Number(expr.dotExpr));
            }
            return new TypeExpr(TypeExprType.CondType, null, [
                condition,
                this.parseTypeExpr(expr.condExpr, where, params),
            ]);
        }

        // Handle different expression types
        if ('kind' in expr) {
            switch (expr.kind) {
                case 'TLBRefType': {
                    // Cell reference: ^Type
                    const refExpr = this.parseTypeExpr(expr.value, where, params);
                    const refTypeExpr = new TypeExpr(TypeExprType.Ref, null, [refExpr]);
                    return this.registerConstExpr(refTypeExpr);
                }
                case 'TLBApplyType': {
                    // Type application: TypeName or TypeName Arg1 Arg2 ...
                    const typeName = expr.name as string;
                    const appliedType = this.findTypeByName(typeName);
                    if (appliedType) {
                        const args: TypeExpr[] = [];
                        if (expr.args && Array.isArray(expr.args)) {
                            for (const arg of expr.args) {
                                args.push(this.parseTypeExpr(arg, where, params));
                            }
                        }
                        const applyExpr = new TypeExpr(
                            TypeExprType.Apply,
                            appliedType,
                            args,
                            0,
                            appliedType.producesNat, // isNat
                            appliedType.producesNat, // isNatSubtype (simplified, usually true if producesNat for builtins like #, ##)
                        );
                        return this.registerConstExpr(applyExpr);
                    }
                    break;
                }
                case 'TLBParamType':
                    // Parameter: #
                    if (expr.name === '#') {
                        const paramExpr = new TypeExpr(TypeExprType.Param, null, [], 0, true, true);
                        return this.registerConstExpr(paramExpr);
                    }
                    break;
                case 'TLBIntType':
                    // Integer constant: (## 5) or similar
                    if (expr.value !== undefined) {
                        const intExpr = new TypeExpr(TypeExprType.IntConst, null, [], expr.value);
                        return this.registerConstExpr(intExpr);
                    }
                    break;
                case 'TLBTupleType': {
                    // Tuple: [field1, field2, ...]
                    const tupleArgs: TypeExpr[] = [];
                    if (expr.fields && Array.isArray(expr.fields)) {
                        for (const field of expr.fields) {
                            if ('type' in field) {
                                tupleArgs.push(this.parseTypeExpr(field.type, where, params));
                            }
                        }
                    }
                    const tupleExpr = new TypeExpr(TypeExprType.Tuple, null, tupleArgs);
                    return this.registerConstExpr(tupleExpr);
                }
                case 'TLBCondType': {
                    // Conditional: condition ? type
                    const condExpr = this.parseTypeExpr(expr.condition, where, params);
                    const thenExpr = this.parseTypeExpr(expr.value, where, params);
                    const condTypeExpr = new TypeExpr(TypeExprType.CondType, null, [condExpr, thenExpr]);
                    return this.registerConstExpr(condTypeExpr);
                }
            }
        }

        // Handle NegateExpr: ~expr (negated expression)
        if (expr instanceof NegateExpr) {
            const innerExpr = this.parseTypeExpr(expr.expr, where, params);

            // For integer constants, evaluate the negation: ~0 = 0, ~1 = 1, etc.
            // In TL-B, ~ on a natural number essentially means "output" rather than bitwise negation
            // The reference implementation shows ~0 as just 0
            if (innerExpr.tp === TypeExprType.IntConst) {
                // Return the constant as-is (negation on constant is identity in output)
                return this.registerConstExpr(innerExpr);
            }

            // For Add/MulConst expressions, apply negation to the first operand only
            // Reference shows ~(n + 1) as (~n + 1)
            if (
                (innerExpr.tp === TypeExprType.Add || innerExpr.tp === TypeExprType.MulConst) &&
                innerExpr.args.length >= 2
            ) {
                // Create negated version of first argument
                const firstArg = innerExpr.args[0];
                const negatedFirstArg = new TypeExpr(
                    firstArg.tp,
                    firstArg.typeApplied,
                    firstArg.args,
                    firstArg.value,
                    firstArg.isNat,
                    firstArg.isNatSubtype,
                    true, // negated = true
                    firstArg.tchkOnly,
                    firstArg.isConstexpr,
                );
                negatedFirstArg.paramName = firstArg.paramName;
                // Create new Add/Mul expression with negated first arg
                const newExpr = new TypeExpr(
                    innerExpr.tp,
                    innerExpr.typeApplied,
                    [negatedFirstArg, innerExpr.args[1]],
                    innerExpr.value,
                    innerExpr.isNat,
                    innerExpr.isNatSubtype,
                    false, // the outer expression is not negated
                    innerExpr.tchkOnly,
                    innerExpr.isConstexpr,
                );
                return this.registerConstExpr(newExpr);
            }

            // Create a negated expression - same as inner but with negated flag
            const negatedExpr = new TypeExpr(
                innerExpr.tp,
                innerExpr.typeApplied,
                innerExpr.args,
                innerExpr.value,
                innerExpr.isNat,
                innerExpr.isNatSubtype,
                true, // negated = true
                innerExpr.tchkOnly,
                innerExpr.isConstexpr,
            );
            negatedExpr.paramName = innerExpr.paramName;
            return this.registerConstExpr(negatedExpr);
        }

        // Handle CellRefExpr: ^expr (cell reference)
        if (expr instanceof CellRefExpr) {
            const innerExpr = this.parseTypeExpr(expr.expr, where, params);
            const refExpr = new TypeExpr(TypeExprType.Ref, null, [innerExpr]);
            return this.registerConstExpr(refExpr);
        }

        // Handle CombinatorExpr: TypeName args...
        if (expr instanceof CombinatorExpr) {
            const typeName = expr.name as string;
            const appliedType = this.findTypeByName(typeName);
            if (appliedType) {
                const args: TypeExpr[] = [];
                if (expr.args && Array.isArray(expr.args)) {
                    for (const arg of expr.args) {
                        args.push(this.parseTypeExpr(arg, where, params));
                    }
                }
                const applyExpr = new TypeExpr(
                    TypeExprType.Apply,
                    appliedType,
                    args,
                    0,
                    appliedType.producesNat,
                    appliedType.producesNat,
                );
                return this.registerConstExpr(applyExpr);
            }
        }

        // Handle MathExpr: left op right (e.g., n + 1)
        if (expr instanceof MathExpr) {
            const leftExpr = this.parseTypeExpr(expr.left, where, params);
            const rightExpr = this.parseTypeExpr(expr.right, where, params);
            const op = expr.op as string;

            // For addition, use TypeExprType.Add
            if (op === '+') {
                const addExpr = new TypeExpr(
                    TypeExprType.Add,
                    null,
                    [leftExpr, rightExpr],
                    0,
                    true, // Result of addition is a nat
                    true,
                );
                return this.registerConstExpr(addExpr);
            }
            // For multiplication, use TypeExprType.MulConst
            // n * Bit is a tuple type (not nat), while n * m (both nats) is still nat
            if (op === '*') {
                const isResultNat = leftExpr.isNat && rightExpr.isNat;
                const mulExpr = new TypeExpr(
                    TypeExprType.MulConst,
                    null,
                    [leftExpr, rightExpr],
                    0,
                    isResultNat,
                    isResultNat,
                );
                return this.registerConstExpr(mulExpr);
            }
        }

        // Handle CompareExpr: left op right (e.g., n <= m)
        if (expr instanceof CompareExpr) {
            const leftExpr = this.parseTypeExpr(expr.left, where, params);
            const rightExpr = this.parseTypeExpr(expr.right, where, params);
            const appliedType = this.findTypeByName(expr.op);
            if (appliedType) {
                return this.registerConstExpr(new TypeExpr(TypeExprType.Apply, appliedType, [leftExpr, rightExpr]));
            }
        }

        // Handle NameExpr: simple variable reference
        if (expr instanceof NameExpr) {
            const exprName = expr.name as string;
            // Check in params
            const nameId = this.symbols.lookup(exprName);
            if (params && params.has(nameId)) {
                const { idx, isNat } = params.get(nameId)!;
                const paramExpr = new TypeExpr(TypeExprType.Param, null, [], idx, isNat, isNat);
                paramExpr.paramName = exprName;
                return this.registerConstExpr(paramExpr);
            }
            // Try to find as type name
            const appliedType = this.findTypeByName(exprName);
            if (appliedType) {
                const applyExpr = new TypeExpr(
                    TypeExprType.Apply,
                    appliedType,
                    [],
                    0,
                    appliedType.producesNat,
                    appliedType.producesNat,
                );
                return this.registerConstExpr(applyExpr);
            }
        }

        // Fallback: try to parse as simple name
        if ('name' in expr) {
            const exprName = expr.name as string;
            if (exprName === '#') {
                const paramExpr = new TypeExpr(TypeExprType.Param, null, [], 0, true, true);
                return this.registerConstExpr(paramExpr);
            } else {
                const appliedType = this.findTypeByName(exprName);
                if (appliedType) {
                    const applyExpr = new TypeExpr(
                        TypeExprType.Apply,
                        appliedType,
                        [],
                        0,
                        appliedType.producesNat,
                        appliedType.producesNat,
                    );
                    return this.registerConstExpr(applyExpr);
                }
                // Check in params
                const nameId = this.symbols.lookup(exprName);
                if (params && params.has(nameId)) {
                    const { idx, isNat } = params.get(nameId)!;
                    const paramExpr = new TypeExpr(
                        TypeExprType.Param,
                        null,
                        [],
                        idx, // Store field index so toString can use _N format
                        isNat,
                        isNat,
                    );
                    paramExpr.paramName = exprName;
                    return this.registerConstExpr(paramExpr);
                }
            }
        }

        // Default: unknown
        return new TypeExpr(TypeExprType.Type, null, [], 'name' in expr ? this.symbols.lookupAdd(expr.name) : 0);
    }

    /**
     * Register constant expression and assign index if it's a constant
     */
    private registerConstExpr(expr: TypeExpr): TypeExpr {
        // Check if expression is constant (doesn't contain parameters)
        const isConst = this.isConstantExpr(expr);
        if (isConst && expr.isConstexpr === 0) {
            const exprStr = expr.toString();
            if (!this.constExprMap.has(exprStr)) {
                this.constExprCounter++;
                this.constExprMap.set(exprStr, this.constExprCounter);
            }
            expr.isConstexpr = this.constExprMap.get(exprStr)!;
        }
        return expr;
    }

    /**
     * Mark fields as 'used' if their names appear as parameters in type expressions
     */
    private markUsedParams(expr: TypeExpr, fields: Field[]): void {
        // If this is a Param type, find the corresponding field and mark it as used
        if (expr.tp === TypeExprType.Param) {
            // The value contains the parameter index (0-based field index)
            const fieldIdx = expr.value;
            if (fieldIdx >= 0 && fieldIdx < fields.length) {
                const field = fields[fieldIdx];
                if (field.implicit) {
                    field.used = true;
                }
            }
        }
        // Recursively check all args
        for (const arg of expr.args) {
            this.markUsedParams(arg, fields);
        }
    }

    /**
     * Check if TypeExpr is constant (doesn't contain parameters)
     */
    private isConstantExpr(expr: TypeExpr): boolean {
        // Exclude 'Type' type
        if (expr.tp === TypeExprType.Apply) {
            if (expr.typeApplied && expr.typeApplied.name === 'Type') {
                return false;
            }
            // Builtin types like # are not constant expressions in output
            if (expr.typeApplied && expr.typeApplied.name === '#') {
                return false;
            }
        }
        // All parameters are not constant
        if (expr.tp === TypeExprType.Param) {
            return false;
        }
        // IntConst with value 0 is not considered a constant expression in output
        // (unless it's explicitly used in the schema)
        if (expr.tp === TypeExprType.IntConst && expr.value === 0) {
            return false;
        }
        // Check all arguments
        for (const arg of expr.args) {
            if (!this.isConstantExpr(arg)) {
                return false;
            }
        }
        return true;
    }

    private defineBuiltins(): void {
        this.defineBuiltinType('#', [], true, 32, 32, true, TypeInteger.Unsigned);
        this.defineBuiltinType('##', ['#'], true, 32, 0, true, TypeInteger.Unsigned);
        this.defineBuiltinType('#<', ['#'], true, 32, 0, false, TypeInteger.Unsigned);
        this.defineBuiltinType('#<=', ['#'], true, 32, 0, false, TypeInteger.Unsigned);
        this.defineBuiltinType('Any', [], false);
        this.defineBuiltinType('Cell', [], false);
        this.defineBuiltinType('int', ['#'], false, 257, 0, true, TypeInteger.Signed);
        this.defineBuiltinType('uint', ['#'], false, 256, 0, true, TypeInteger.Unsigned);
        this.defineBuiltinType('bits', ['#'], false, 1023, 0, true);
        this.defineBuiltinType('SnakeString', [], false);
        for (let i = 1; i <= 257; i++) {
            // Define intN types (1 to 257)
            this.defineBuiltinType(`int${i}`, [], false, i, i, true, TypeInteger.Signed);
            // Define uintN types (1 to 256)
            if (i <= 256) {
                this.defineBuiltinType(`uint${i}`, [], false, i, i, true, TypeInteger.Unsigned);
            }
        }
        // Define bitsN types (1 to 1023)
        for (let i = 1; i <= 1023; i++) {
            this.defineBuiltinType(`bits${i}`, [], false, i, i, true);
        }
        for (const op of ['=', '<', '<=', '>', '>=', '!=']) {
            this.defineBuiltinType(op, ['##'], false, 0, 0, true);
        }
    }

    private defineBuiltinType(
        name: string = '',
        args: string[],
        producesNat: boolean,
        size: number = Undefined,
        minSize: number = Undefined,
        anyBits: boolean = false,
        isInteger: number = TypeInteger.None,
    ): Type {
        const typeId = this.types.length;
        const type = Type.builtinType(this.symbols, name, typeId, args, producesNat, size, minSize, anyBits, isInteger);
        this.types.push(type);
        this.builtinTypesNum += 1;
        return type;
    }

    // ---------------------------
    // Runtime view conversion (TLBType/TLBConstructor/TLBFieldType)
    // ---------------------------

    /**
     * Get TLBTypes (memoized view of Schema for runtime)
     */
    getTLBTypes(): ReadonlyMap<string, import('../types').TLBType> {
        if (!this.tlbTypesCache) {
            this.tlbTypesCache = this.toTLBTypes();
        }
        return this.tlbTypesCache;
    }

    /**
     * Get a TLBType by name
     */
    getTLBType(name: string): import('../types').TLBType | undefined {
        return this.getTLBTypes().get(name);
    }

    /**
     * Get all TLBType names in declaration order
     */
    getTLBTypeNames(): string[] {
        // Return user type names in the order they were declared (from userTypes array)
        return this.userTypes.map((t) => t.name);
    }

    /**
     * Convert this Schema to TLBType Map for TLBRuntime compatibility (internal)
     */
    private toTLBTypes(): Map<string, import('../types').TLBType> {
        const types = new Map<string, import('../types').TLBType>();

        // Anonymous groups are implementation details and cannot be inferred as the root.
        const userTypes = this.userTypes;
        for (const type of [...userTypes.filter((t) => t.isAnon), ...userTypes.filter((t) => !t.isAnon)]) {
            const tlbType: import('../types').TLBType = {
                name: type.name,
                ...(type.isAnon && { isAnon: true }),
                constructors: [],
            };

            let anonymousCount = 0;
            for (const constructor of type.constructors) {
                const constructorName = this.symbols.getName(constructor.constrName) || '_';

                const declaration = this.declarationText.get(constructor) ?? '';
                const isAnonymous = constructorName === '_' || constructorName === '';
                const { tagBits, tag: tagValue } = constructor;
                const tagBinary = `0x${tagValue.toString(16).padStart(Math.ceil(tagBits / 4), '0')}`;

                const paramNameMap = new Map<number, string>();
                for (const [index, field] of constructor.fields.entries()) {
                    const name = field.name && this.symbols.getName(field.name);
                    if (name) paramNameMap.set(index, name);
                }

                const parameters: import('../types').TLBParameter[] = [];
                const parametersMap = new Map<string, import('../types').TLBParameter>();
                const variables: import('../types').TLBVariable[] = [];
                const variablesMap = new Map<string, import('../types').TLBVariable>();

                for (let i = 0; i < constructor.params.length; i++) {
                    const paramExpr = constructor.params[i];
                    const vars = new Set<string>();
                    const collect = (expr: TypeExpr) => {
                        if (expr.tp === TypeExprType.Param) {
                            const name = paramNameMap.get(expr.value);
                            if (name) vars.add(name);
                        } else expr.args.forEach(collect);
                    };
                    collect(paramExpr);
                    const paramName = vars.size === 1 ? Array.from(vars)[0] : `param${i}`;
                    const isNegated = constructor.paramNegated[i];
                    const isConst = constructor.paramConstVal[i] !== undefined;
                    const constVal = constructor.paramConstVal[i];

                    const param: import('../types').TLBParameter = {
                        variable: {
                            name: paramName,
                            type: paramExpr.isNat ? '#' : 'Type',
                            negated: isNegated,
                            isConst: isConst,
                        },
                    };

                    try {
                        const mathExpr = this.typeExprToTLBMathExpr(paramExpr, paramNameMap);
                        param.variable.deriveExpr = mathExpr;
                        param.paramExpr = mathExpr;
                    } catch {
                        // Ignore if conversion fails
                    }

                    if (constVal !== undefined) {
                        param.variable.constValue = constVal;
                    }

                    parameters.push(param);
                    parametersMap.set(paramName, param);

                    const varObj: import('../types').TLBVariable = {
                        name: paramName,
                        type: (paramExpr.isNat ? '#' : 'Type') as '#' | 'Type',
                        negated: isNegated,
                    };
                    variables.push(varObj);
                    variablesMap.set(paramName, varObj);
                }

                // Build parameter name map
                for (const [index, f] of constructor.fields.entries()) {
                    if (f.name !== 0) {
                        const fName = this.symbols.getName(f.name);
                        if (fName) paramNameMap.set(index, fName);
                        if (fName && !variablesMap.has(fName)) {
                            const varObj: import('../types').TLBVariable = {
                                name: fName,
                                type: '#',
                                negated: false,
                                isField: true,
                            };
                            variables.push(varObj);
                            variablesMap.set(fName, varObj);
                        }
                    }
                }
                // Convert fields and constraints
                const fields: import('../types').TLBField[] = [];
                const constraints: import('../types').TLBMathExpr[] = [];

                for (const field of constructor.fields) {
                    if (field.constraint) {
                        try {
                            const constraintExpr = this.typeExprToTLBMathExpr(field.type, paramNameMap);
                            constraints.push(constraintExpr);
                        } catch (error) {
                            const reason = error instanceof Error ? error.message : String(error);
                            throw new TLBSchemaError(
                                `Invalid constraint in ${type.name} at ${field.loc.line}:${field.loc.column}: ${reason}`,
                            );
                        }
                    } else {
                        const fieldName = field.name === 0 ? undefined : this.symbols.getName(field.name);
                        try {
                            const fieldType = this.typeExprToTLBFieldType(field.type, paramNameMap);
                            fields.push({
                                name: fieldName,
                                fieldType: fieldType,
                                subFields: [],
                                implicit: field.implicit,
                            });
                        } catch (error) {
                            const reason = error instanceof Error ? error.message : String(error);
                            throw new TLBSchemaError(`Invalid field ${fieldName ?? '_'} in ${type.name}: ${reason}`);
                        }
                    }
                }

                const resultParameters: import('../types').TLBMathExpr[] = [];
                for (const pExpr of constructor.params) {
                    try {
                        resultParameters.push(this.typeExprToTLBMathExpr(pExpr, paramNameMap));
                    } catch {
                        /* skip non-math params */
                    }
                }

                const tlbConstructor: import('../types').TLBConstructor = {
                    name: isAnonymous && anonymousCount > 0 ? `_${anonymousCount}` : constructorName,
                    tag: {
                        bitLen: tagBits,
                        binary: tagBinary,
                    },
                    fields: fields,
                    constraints: constraints,
                    declaration: declaration,
                    parameters: parameters,
                    parametersMap: parametersMap,
                    variables: variables,
                    variablesMap: variablesMap,
                    tlbType: type.name,
                    resultParameters: resultParameters,
                };

                tlbType.constructors.push(tlbConstructor);
                if (isAnonymous) anonymousCount++;
            }

            types.set(type.name, tlbType);
        }

        const groupConstraints = new Map<import('../types').TLBField, import('../types').TLBMathExpr[]>();
        for (const type of types.values()) {
            for (const constructor of type.constructors) {
                for (const field of constructor.fields) {
                    if (field.name || field.fieldType.kind !== 'TLBRefType') continue;
                    const target = field.fieldType.value;
                    if (target.kind !== 'TLBNamedType' || !this.findTypeByName(target.name)?.isAnon) continue;
                    const group = types.get(target.name)!.constructors[0];
                    field.subFields = group.fields;
                    groupConstraints.set(field, [...group.constraints]);
                }
            }
        }

        for (const type of types.values()) {
            for (const constructor of type.constructors) {
                const paths = new Map<string, string>();
                let anonymousIndex = 0;
                const visit = (fields: typeof constructor.fields, parent: string, root: boolean) => {
                    fields.forEach((field, i) => {
                        const path = parent + '[' + i + ']';
                        const key = field.name || (root || !field.subFields.length ? 'anon' + anonymousIndex++ : '');
                        if (field.implicit) return;
                        if (!field.name && field.subFields.length) {
                            constructor.constraints.push(...(groupConstraints.get(field) ?? []));
                            visit(field.subFields, path, false);
                            return;
                        }
                        const previous = paths.get(key);
                        if (previous !== undefined) {
                            throw new TLBSchemaError(
                                `Duplicate decoded field ${key} in ${type.name} at ${previous} and ${path}`,
                            );
                        }
                        paths.set(key, path);
                    });
                };
                visit(constructor.fields, 'fields', true);
            }
        }

        return types;
    }

    /**
     * Convert TypeExpr to TLBFieldType for parameterized types
     */
    private typeExprToTLBFieldType(
        expr: TypeExpr,
        paramNameMap?: Map<number, string>,
    ): import('../types').TLBFieldType {
        if (expr.tp === TypeExprType.Param && expr.isNat && expr.isNatSubtype && !expr.negated) {
            return {
                kind: 'TLBNumberType',
                bits: { kind: 'TLBNumberExpr', n: 32 },
                signed: false,
            };
        }

        switch (expr.tp) {
            case TypeExprType.Apply: {
                if (!expr.typeApplied) {
                    throw new Error('TypeExpr.Apply without typeApplied');
                }
                const typeName = this.symbols.getName(expr.typeApplied.typeNameId) || '?';

                if (typeName === '#') {
                    return {
                        kind: 'TLBNumberType',
                        bits: { kind: 'TLBNumberExpr', n: 32 },
                        signed: false,
                    };
                }

                if (typeName === '##') {
                    if (expr.args.length === 0) {
                        throw new Error('## type requires an argument');
                    }
                    const bitsExpr = this.typeExprToTLBMathExpr(expr.args[0], paramNameMap);
                    return {
                        kind: 'TLBNumberType',
                        bits: bitsExpr,
                        signed: false,
                    };
                }

                if (typeName === 'int') {
                    if (expr.args.length === 0) {
                        throw new Error('int type requires an argument');
                    }
                    const bitsExpr = this.typeExprToTLBMathExpr(expr.args[0], paramNameMap);
                    return {
                        kind: 'TLBNumberType',
                        bits: bitsExpr,
                        signed: true,
                    };
                }

                if (typeName === 'uint') {
                    if (expr.args.length === 0) {
                        throw new Error('uint type requires an argument');
                    }
                    const bitsExpr = this.typeExprToTLBMathExpr(expr.args[0], paramNameMap);
                    return {
                        kind: 'TLBNumberType',
                        bits: bitsExpr,
                        signed: false,
                    };
                }

                if (typeName === '#<') {
                    if (expr.args.length === 0) {
                        throw new Error('#< type requires an argument');
                    }
                    const nExpr = this.typeExprToTLBMathExpr(expr.args[0], paramNameMap);
                    return {
                        kind: 'TLBNumberType',
                        upperBound: {
                            kind: 'TLBBinaryOp',
                            operation: '-',
                            left: nExpr,
                            right: { kind: 'TLBNumberExpr', n: 1 },
                        },
                        bits: {
                            kind: 'TLBUnaryOp',
                            operation: '.',
                            value: {
                                kind: 'TLBBinaryOp',
                                operation: '-',
                                left: nExpr,
                                right: { kind: 'TLBNumberExpr', n: 1 },
                            },
                        },
                        signed: false,
                    };
                }

                if (typeName === '#<=') {
                    if (expr.args.length === 0) {
                        throw new Error('#<= type requires an argument');
                    }
                    const nExpr = this.typeExprToTLBMathExpr(expr.args[0], paramNameMap);
                    return {
                        kind: 'TLBNumberType',
                        upperBound: nExpr,
                        bits: {
                            kind: 'TLBUnaryOp',
                            operation: '.',
                            value: nExpr,
                        },
                        signed: false,
                    };
                }

                if (typeName === 'bits') {
                    if (expr.args.length === 0) {
                        throw new Error('bits type requires an argument');
                    }
                    const bitsExpr = this.typeExprToTLBMathExpr(expr.args[0], paramNameMap);
                    return {
                        kind: 'TLBBitsType',
                        bits: bitsExpr,
                    };
                }

                if (typeName === 'MsgAddress' || typeName === 'MsgAddressInt' || typeName === 'MsgAddressExt') {
                    return {
                        kind: 'TLBAddressType',
                        name: typeName,
                    };
                }

                const definition = expr.typeApplied.constructors[0];
                const constructorName = definition && this.symbols.getName(definition.constrName);
                if (typeName === 'VmStack' && constructorName === 'vm_stack') {
                    return { kind: 'TLBTupleType' };
                }
                if (expr.typeApplied.isBuiltin && (typeName === 'Coins' || typeName === 'Grams'))
                    return { kind: 'TLBCoinsType' };
                if (expr.typeApplied.isBuiltin && typeName === 'HashmapE') {
                    if (expr.args.length !== 2) throw new Error('HashmapE requires a key width and value type');
                    return {
                        kind: 'TLBHashmapType',
                        key: this.typeExprToTLBMathExpr(expr.args[0], paramNameMap),
                        value: this.typeExprToTLBFieldType(expr.args[1], paramNameMap),
                    };
                }
                if (expr.typeApplied.isBuiltin && typeName === 'VarUInteger') {
                    if (expr.args.length !== 1) throw new Error('VarUInteger requires one size argument');
                    const bound = this.typeExprToTLBMathExpr(expr.args[0], paramNameMap);
                    return {
                        kind: 'TLBVarIntegerType',
                        upperBound: bound,
                        signed: false,
                        n: {
                            kind: 'TLBUnaryOp',
                            operation: '.',
                            value: {
                                kind: 'TLBBinaryOp',
                                operation: '-',
                                left: bound,
                                right: { kind: 'TLBNumberExpr', n: 1 },
                            },
                        },
                    };
                }
                if (typeName === 'Bool' || (typeName === 'Bit' && constructorName === 'bit')) {
                    return {
                        kind: 'TLBBoolType',
                    };
                }

                if (typeName === 'Cell') {
                    return {
                        kind: 'TLBCellType',
                    };
                }

                const uintMatch = typeName.match(/^uint(\d+)$/);
                if (uintMatch) {
                    return {
                        kind: 'TLBNumberType',
                        bits: { kind: 'TLBNumberExpr', n: parseInt(uintMatch[1], 10) },
                        signed: false,
                    };
                }
                const intMatch = typeName.match(/^int(\d+)$/);
                if (intMatch) {
                    return {
                        kind: 'TLBNumberType',
                        bits: { kind: 'TLBNumberExpr', n: parseInt(intMatch[1], 10) },
                        signed: true,
                    };
                }
                const bitsMatch = typeName.match(/^bits(\d+)$/);
                if (bitsMatch) {
                    return {
                        kind: 'TLBBitsType',
                        bits: { kind: 'TLBNumberExpr', n: parseInt(bitsMatch[1], 10) },
                    };
                }

                const args: import('../types').TLBFieldType[] = expr.args.map((arg) => {
                    if (arg.tp === TypeExprType.Param && arg.negated) {
                        return {
                            kind: 'TLBNegatedType',
                            variableName: arg.paramName ?? paramNameMap?.get(arg.value) ?? `_${arg.value + 1}`,
                        };
                    }
                    if (
                        (arg.tp === TypeExprType.Param || arg.tp === TypeExprType.MulConst) &&
                        arg.isNat &&
                        !arg.negated
                    ) {
                        return { kind: 'TLBExprMathType', initialExpr: this.typeExprToTLBMathExpr(arg, paramNameMap) };
                    }
                    return this.typeExprToTLBFieldType(arg, paramNameMap);
                });
                return {
                    kind: 'TLBNamedType',
                    name: typeName,
                    arguments: args,
                };
            }
            case TypeExprType.CondType:
                return {
                    kind: 'TLBCondType',
                    condition: this.typeExprToTLBMathExpr(expr.args[0], paramNameMap),
                    value: this.typeExprToTLBFieldType(expr.args[1], paramNameMap),
                };
            case TypeExprType.MulConst:
                return {
                    kind: 'TLBMultipleType',
                    times: this.typeExprToTLBMathExpr(expr.args[0], paramNameMap),
                    value: this.typeExprToTLBFieldType(expr.args[1], paramNameMap),
                };
            case TypeExprType.IntConst: {
                return {
                    kind: 'TLBNumberType',
                    bits: {
                        kind: 'TLBNumberExpr',
                        n: expr.value,
                    },
                    signed: false,
                };
            }
            case TypeExprType.Add: {
                const left = expr.args.length >= 1 ? expr.args[0] : null;
                const right = expr.args.length >= 2 ? expr.args[1] : null;
                const constValue = expr.value;

                let leftExpr: import('../types').TLBMathExpr;
                let rightExpr: import('../types').TLBMathExpr;

                if (left) {
                    leftExpr = this.typeExprToTLBMathExpr(left, paramNameMap);
                } else {
                    leftExpr = { kind: 'TLBNumberExpr', n: 0 };
                }

                if (right) {
                    rightExpr = this.typeExprToTLBMathExpr(right, paramNameMap);
                } else if (constValue !== 0) {
                    rightExpr = { kind: 'TLBNumberExpr', n: constValue };
                } else {
                    rightExpr = { kind: 'TLBNumberExpr', n: 0 };
                }

                return {
                    kind: 'TLBExprMathType',
                    initialExpr: {
                        kind: 'TLBBinaryOp',
                        operation: '+',
                        left: leftExpr,
                        right: rightExpr,
                    },
                };
            }
            case TypeExprType.Param: {
                const paramName = expr.paramName || paramNameMap?.get(expr.value) || `_${expr.value + 1}`;

                if (expr.isNat) {
                    return {
                        kind: 'TLBNumberType',
                        bits: {
                            kind: 'TLBVarExpr',
                            x: paramName,
                        },
                        signed: false,
                    };
                } else {
                    return {
                        kind: 'TLBNamedType',
                        name: paramName,
                        arguments: [],
                    };
                }
            }
            case TypeExprType.Ref: {
                if (expr.args.length >= 1) {
                    const innerType = this.typeExprToTLBFieldType(expr.args[0], paramNameMap);
                    return {
                        kind: 'TLBRefType',
                        value: innerType,
                    };
                }
                throw new Error('TypeExpr.Ref without inner type');
            }
            default: {
                if (expr.typeApplied) {
                    const typeName = this.symbols.getName(expr.typeApplied.typeNameId) || '?';
                    return {
                        kind: 'TLBNamedType',
                        name: typeName,
                        arguments: [],
                    };
                }
                throw new Error(`Unsupported TypeExpr type: ${expr.tp}`);
            }
        }
    }

    /**
     * Convert TypeExpr to TLBMathExpr for MathExprEvaluator
     */
    private typeExprToTLBMathExpr(expr: TypeExpr, paramNameMap?: Map<number, string>): import('../types').TLBMathExpr {
        if (expr.negated) {
            const positive = new TypeExpr(
                expr.tp,
                expr.typeApplied,
                expr.args,
                expr.value,
                expr.isNat,
                expr.isNatSubtype,
                false,
                expr.tchkOnly,
                expr.isConstexpr,
            );
            positive.paramName = expr.paramName;
            const innerExpr = this.typeExprToTLBMathExpr(positive, paramNameMap);
            return {
                kind: 'TLBUnaryOp',
                operation: '~',
                value: innerExpr,
            };
        }

        switch (expr.tp) {
            case TypeExprType.IntConst:
                return { kind: 'TLBNumberExpr', n: expr.value };
            case TypeExprType.Param: {
                const paramName = expr.paramName || paramNameMap?.get(expr.value) || `_${expr.value + 1}`;
                return { kind: 'TLBVarExpr', x: paramName };
            }
            case TypeExprType.Add: {
                const left =
                    expr.args.length >= 1
                        ? this.typeExprToTLBMathExpr(expr.args[0], paramNameMap)
                        : { kind: 'TLBNumberExpr' as const, n: 0 };
                const right =
                    expr.args.length >= 2
                        ? this.typeExprToTLBMathExpr(expr.args[1], paramNameMap)
                        : expr.value !== 0
                          ? { kind: 'TLBNumberExpr' as const, n: expr.value }
                          : { kind: 'TLBNumberExpr' as const, n: 0 };
                return {
                    kind: 'TLBBinaryOp',
                    operation: '+',
                    left: left,
                    right: right,
                };
            }
            case TypeExprType.Apply: {
                if (expr.typeApplied && expr.args.length === 2) {
                    const typeName = this.symbols.getName(expr.typeApplied.typeNameId) || '?';
                    const left = this.typeExprToTLBMathExpr(expr.args[0], paramNameMap);
                    const right = this.typeExprToTLBMathExpr(expr.args[1], paramNameMap);

                    let operation: string;
                    switch (typeName) {
                        case '<=':
                            operation = '<=';
                            break;
                        case '<':
                            operation = '<';
                            break;
                        case '=':
                            operation = '=';
                            break;
                        case '>=':
                            operation = '>=';
                            break;
                        case '>':
                            operation = '>';
                            break;
                        case '!=':
                            operation = '!=';
                            break;
                        default:
                            throw new Error(`Cannot use ${typeName} as a number`);
                    }

                    return {
                        kind: 'TLBBinaryOp',
                        operation: operation as '+' | '-' | '*' | '/',
                        left: left,
                        right: right,
                    };
                }
                break;
            }
            case TypeExprType.MulConst: {
                if (expr.args.length >= 2) {
                    const left = this.typeExprToTLBMathExpr(expr.args[0], paramNameMap);
                    const right = this.typeExprToTLBMathExpr(expr.args[1], paramNameMap);
                    return {
                        kind: 'TLBBinaryOp',
                        operation: '*',
                        left: left,
                        right: right,
                    };
                } else if (expr.args.length === 1) {
                    const left = { kind: 'TLBNumberExpr' as const, n: expr.value };
                    const right = this.typeExprToTLBMathExpr(expr.args[0], paramNameMap);
                    return {
                        kind: 'TLBBinaryOp',
                        operation: '*',
                        left: left,
                        right: right,
                    };
                }
                break;
            }
            case TypeExprType.GetBit: {
                if (expr.args.length > 0) {
                    const left = this.typeExprToTLBMathExpr(expr.args[0], paramNameMap);
                    return {
                        kind: 'TLBBinaryOp',
                        operation: '.',
                        left: left,
                        right: { kind: 'TLBNumberExpr', n: expr.value },
                    };
                }
                break;
            }
            case TypeExprType.Type:
                throw new Error('Unknown numeric identifier ' + (this.symbols.getName(expr.value) || '?'));
        }
        throw new Error(`Cannot use ${expr.typeApplied?.name ?? TypeExprType[expr.tp]} as a number`);
    }
}
