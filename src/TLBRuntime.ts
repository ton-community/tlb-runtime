import {
    Builder,
    Slice,
    Cell,
    beginCell,
    Dictionary,
    parseTuple,
    serializeTuple,
    BitString,
    Address,
    ExternalAddress,
    DictionaryKeyTypes,
    DictionaryKey,
} from '@ton/core';

import { compileLegacySchema, legacyFieldName } from './legacySchema';
import { Schema } from './schema';
import { decodeBits, stringToBits, toCell } from './common';
import { MathExprEvaluator, safeExpressionNumber } from './MathExprEvaluator';
import { Result, unwrap } from './Result';
import { TLBRuntimeError, TLBSchemaError, TLBDataError, UnknownKindError } from './errors';
import {
    TLBMathExpr as _TLBMathExpr,
    TLBConstructorTag,
    TLBFieldType,
    TLBField,
    TLBConstructor,
    TLBType,
} from './types';

export interface TypeCell {
    kind: string;
    [key: string]: DecodedCell | unknown;
}

export type DecodedCell =
    | string
    | number
    | bigint
    | boolean
    | null
    | BitString
    | Address
    | ExternalAddress
    | Dictionary<DictionaryKeyTypes, DecodedCell>
    | Cell
    | DecodedCell[]
    | TypeCell;

/** @deprecated Use TypedCell for decoded records or DecodedCell for field values. */
export type ParsedCell = unknown;
type DecodedRoot<T> = unknown extends T ? TypedCell : T;

export type TypedCell = TypeCell & DecodedCell;

export { TLBRuntimeError, TLBSchemaError, TLBDataError };

/**
 * ParameterContext tracks type and numeric parameter bindings across deserialization chain.
 * Supports parent-child chaining for nested type instantiations.
 *
 * Example: When deserializing HashmapVarKey 5:
 * 1. Context is created with n=5
 * 2. When deserializing nested HashmapE n uint5, child context inherits n=5
 * 3. When deserializing field 'value:X', parameter X is resolved from context
 */
const definingScope = Symbol('anonymous TL-B type scope');
type ScopedField = TLBFieldType & {
    [definingScope]?: { variables: Map<string, number | bigint>; context: ParameterContext };
};

class ParameterContext {
    private natParams: Map<string, number> = new Map();
    private typeParams: Map<string, TLBFieldType> = new Map();

    constructor(private parent?: ParameterContext) {}

    /**
     * Add a Nat parameter binding (numeric parameter like {n:#})
     */
    setNat(name: string, value: number): void {
        this.natParams.set(name, value);
    }

    /**
     * Add a Type parameter binding (type parameter like {X:Type})
     */
    setType(name: string, type: TLBFieldType): void {
        this.typeParams.set(name, type);
    }

    /**
     * Resolve Nat parameter from context chain (searches parent if not found locally)
     */
    resolveNat(name: string): number | undefined {
        const val = this.natParams.get(name);
        if (val !== undefined) return val;
        return this.parent?.resolveNat(name);
    }

    /**
     * Resolve Type parameter from context chain (searches parent if not found locally)
     */
    resolveType(name: string): TLBFieldType | undefined {
        const val = this.typeParams.get(name);
        if (val !== undefined) return val;
        return this.parent?.resolveType(name);
    }

    /**
     * Create child context that inherits from this context
     */
    extend(): ParameterContext {
        return new ParameterContext(this);
    }

    /**
     * Get all Nat parameters in this context and parents (for debugging)
     */
    getAllNatParams(): Map<string, number> {
        const result = new Map(this.parent?.getAllNatParams() ?? []);
        for (const [k, v] of this.natParams) {
            result.set(k, v);
        }
        return result;
    }

    /**
     * Get all Type parameters in this context and parents (for debugging)
     */
    getAllTypeParams(): Map<string, TLBFieldType> {
        const result = new Map(this.parent?.getAllTypeParams() ?? []);
        for (const [k, v] of this.typeParams) {
            result.set(k, v);
        }
        return result;
    }
}

// Older writers numbered anonymous leaves separately inside each reference group.
function canUseLegacyAnon0(leaf: TLBField, fields: TLBField[]): boolean {
    return fields.every((field) => {
        if (field === leaf || field.implicit) return true;
        if (field.name === 'anon0') return false;
        return field.subFields.length ? canUseLegacyAnon0(leaf, field.subFields) : !!field.name;
    });
}

class UnsupportedAddressError extends TLBDataError {}

function readAddress(slice: Slice, name = 'MsgAddress') {
    if (slice.remainingBits < 2) throw new TLBDataError('Not enough bits for ' + name + ': expected a 2-bit tag');
    const tag = slice.preloadUint(2);
    if ((name === 'MsgAddressInt' && tag < 2) || (name === 'MsgAddressExt' && tag >= 2)) {
        throw new TLBDataError('Invalid address tag ' + tag + ' for ' + name);
    }
    if (tag === 3) throw new UnsupportedAddressError('addr_var is unsupported by TON Core');
    if (tag === 2 && slice.preloadUint(3) === 5)
        throw new UnsupportedAddressError('Anycast address is unsupported by TON Core');
    return slice.loadAddressAny();
}

function writeAddress(builder: Builder, value: Address | ExternalAddress | string | null, name = 'MsgAddress') {
    const address = typeof value === 'string' ? Address.parse(value) : value;
    const internal = Address.isAddress(address);
    if ((name === 'MsgAddressInt' && !internal) || (name === 'MsgAddressExt' && internal)) {
        throw new TLBDataError('Invalid address value for ' + name);
    }
    builder.storeAddress(address);
}

function loadRemainingCell(slice: Slice): Cell {
    const builder = beginCell().storeBits(slice.loadBits(slice.remainingBits));
    while (slice.remainingRefs) builder.storeRef(slice.loadRef());
    return builder.endCell();
}

// Capture numeric expressions before a type argument enters a new constructor scope.
function bindNumericArgument(type: TLBFieldType, evaluator: MathExprEvaluator): TLBFieldType {
    const bind = (expr: _TLBMathExpr): _TLBMathExpr =>
        expr.kind === 'TLBNumberExpr' ? expr : { kind: 'TLBNumberExpr', n: evaluator.evaluate(expr) };
    switch (type.kind) {
        case 'TLBNamedType':
            return { ...type, arguments: type.arguments.map((arg) => bindNumericArgument(arg, evaluator)) };
        case 'TLBNumberType':
            return { ...type, bits: bind(type.bits), ...(type.upperBound && { upperBound: bind(type.upperBound) }) };
        case 'TLBBitsType':
            return { ...type, bits: bind(type.bits) };
        case 'TLBExprMathType':
            return { ...type, initialExpr: bind(type.initialExpr) };
        case 'TLBVarIntegerType':
            return { ...type, n: bind(type.n), ...(type.upperBound && { upperBound: bind(type.upperBound) }) };
        case 'TLBMultipleType':
            return { ...type, times: bind(type.times), value: bindNumericArgument(type.value, evaluator) };
        case 'TLBHashmapType':
            return { ...type, key: bind(type.key), value: bindNumericArgument(type.value, evaluator) };
        case 'TLBConditionalType':
        case 'TLBCondType':
            return { ...type, condition: bind(type.condition), value: bindNumericArgument(type.value, evaluator) };
        case 'TLBRefType':
        case 'TLBCellInsideType':
            return { ...type, value: bindNumericArgument(type.value, evaluator) };
        default:
            return type;
    }
}

function checkNatUpperBound(value: number | bigint, maximum: number): void {
    if (BigInt(value) > BigInt(maximum)) throw new TLBDataError('Natural number exceeds its schema bound');
}

function tagKey(tag: TLBConstructorTag): string {
    return `0b${BigInt(tag.binary).toString(2).padStart(tag.bitLen, '0')}`;
}

export interface DecodeCellOptions {
    rootType?: string;
    /** Numeric TL-B arguments in result-type order, e.g. [4] for "Tree 4". */
    args?: readonly number[];
}

type DecodeFrame<T, R = Result<T>> = Generator<DecodeFrame<T>, R, Result<T>>;
class DecodeDepthError extends TLBRuntimeError {}

export interface TLBRuntimeConfig {
    autoText: boolean;
    /** Maximum active named types when decoding, including inline wrappers. Defaults to 4096. */
    maxDecodeDepth?: number;
}

// Runtime TL-B serialization/deserialization
export class TLBRuntime<T = ParsedCell> {
    private readonly tagMap = new Map<string, { type: TLBType; item: TLBConstructor }>();
    private maxSizeTag = 0;
    private readonly typeMap: ReadonlyMap<string, TLBType>;
    /** Last result type declared by the schema compiler. */
    readonly lastTypeName?: string;
    private readonly resultArgs = new WeakMap<object, (number | undefined)[]>();
    private activeDecodeFrames = 0;
    private constructor(
        readonly schema: string,
        readonly config: Readonly<Partial<TLBRuntimeConfig>> = {},
        private readonly compileSchema = (code: string) => {
            const schema = unwrap(Schema.from(code));
            return { types: schema.getTLBTypes(), lastTypeName: schema.lastTypeName };
        },
    ) {
        if (
            config.maxDecodeDepth !== undefined &&
            (!Number.isSafeInteger(config.maxDecodeDepth) || config.maxDecodeDepth < 1)
        )
            throw new TLBSchemaError('maxDecodeDepth must be a positive safe integer');
        const compiled = compileSchema(schema);
        this.typeMap = compiled.types;
        this.lastTypeName = compiled.lastTypeName;
        (config as Partial<TLBRuntimeConfig>).autoText = config.autoText ?? true;
        for (const type of this.typeMap.values()) {
            for (const item of type.constructors) {
                if (item.tag.bitLen > 0) {
                    if (item.tag.bitLen > this.maxSizeTag) {
                        this.maxSizeTag = item.tag.bitLen;
                    }
                    const key = tagKey(item.tag);
                    this.tagMap.set(key, { type, item });
                }
            }
        }
    }

    static from<T = ParsedCell>(schema: string, config: Partial<TLBRuntimeConfig> = {}): Result<TLBRuntime<T>> {
        return TLBRuntime.create(schema, config, compileLegacySchema);
    }

    static compile<T = TypedCell>(schema: string, config: Partial<TLBRuntimeConfig> = {}): Result<TLBRuntime<T>> {
        return TLBRuntime.create(schema, config);
    }

    /** @deprecated Use runtimeBy for schemas supported by the current parser. */
    static parseTLB<T = ParsedCell>(schema: string): TLBRuntime<T> {
        const result = TLBRuntime.from<T>(schema);
        if (!result.success) throw new TLBSchemaError('Bad Schema', result.error);
        return result.value;
    }

    private static create<T>(
        schema: string,
        config: Partial<TLBRuntimeConfig>,
        compileSchema?: (code: string) => { types: ReadonlyMap<string, TLBType>; lastTypeName: string | undefined },
    ): Result<TLBRuntime<T>> {
        try {
            return {
                success: true,
                value: new TLBRuntime(schema, config, compileSchema),
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Failed to convert schema';
            return { success: false, error: new TLBSchemaError(errorMessage, error) };
        }
    }

    /** Returns normalized types in schema order. */
    getTypes(): ReadonlyMap<string, TLBType> {
        return this.typeMap;
    }

    /** @deprecated Use getTypes() instead. */
    get types(): ReadonlyMap<string, TLBType> {
        return this.getTypes();
    }

    changeSchema(schema: string): Result<TLBRuntime<T>> {
        if (this.schema === schema) {
            return {
                success: true,
                value: this,
            };
        }
        return TLBRuntime.create(schema, this.config, this.compileSchema);
    }

    decodeCell(data: Cell | string, options?: DecodeCellOptions): DecodedRoot<T> {
        return unwrap(this.deserialize(data, options)) as DecodedRoot<T>;
    }

    /** @deprecated Use decodeCell instead. */
    parseCell(data: Cell | string): ParsedCell {
        return this.decodeCell(data);
    }

    encodeCell(data: unknown): Cell {
        if (typeof data === 'string') {
            data = JSON.parse(data) as T;
        }
        return unwrap(this.serialize(data as T)).endCell();
    }

    private findByTag(slice: Slice): { type: TLBType; item: TLBConstructor } | null {
        const savedBits = slice.remainingBits;
        const maxLen = Math.min(this.maxSizeTag, savedBits);

        for (let len = maxLen; len >= 1; len--) {
            if (savedBits < len) continue;
            const tagValue = slice.preloadUintBig(len);
            const key = tagKey({
                bitLen: len,
                binary: `0x${tagValue.toString(16)}`,
            });
            const type = this.tagMap.get(key);
            if (type) {
                return type;
            }
        }

        return null;
    }

    deserialize(data: Cell | string, options: boolean | DecodeCellOptions = false): Result<T> {
        try {
            return this.decodeRoot(data, options);
        } catch (error) {
            if (error instanceof DecodeDepthError || error instanceof RangeError) return { success: false, error };
            throw error;
        }
    }

    private decodeRoot(data: Cell | string, options: boolean | DecodeCellOptions): Result<T> {
        const parsed = typeof data === 'string' ? toCell(data) : { success: true as const, value: data };
        if (!parsed.success) return parsed;
        const slice = parsed.value.asSlice();
        const findByTag = options === true;
        const { rootType, args } = typeof options === 'boolean' ? {} : options;
        if (rootType !== undefined) {
            const type = this.typeMap.get(rootType);
            if (!type) return { success: false, error: new TLBDataError(`Unknown root type: ${rootType}`) };
            if (args?.some((n) => !Number.isSafeInteger(n) || n < 0))
                return { success: false, error: new TLBDataError('Expected a natural number argument') };
            const bindings: TLBFieldType[] = (args ?? []).map((n) => ({
                kind: 'TLBExprMathType',
                initialExpr: { kind: 'TLBNumberExpr', n },
            }));
            if (!type.constructors.some((c) => c.parameters.length >= bindings.length))
                return { success: false, error: new TLBDataError(`Too many arguments for ${type.name}`) };
            return this.runDecode(this.deserializeType(type, slice, bindings));
        }
        if (args !== undefined)
            return { success: false, error: new TLBDataError('Numeric arguments require a root type') };
        if (findByTag) {
            const find = this.findByTag(slice);
            if (find) {
                return this.runDecode(this.deserializeConstructor(find.type, find.item, slice));
            }
        }

        const names = new Set([this.lastTypeName, ...Array.from(this.typeMap.keys()).reverse()]);
        for (const name of names) {
            if (name === undefined) continue;
            const type = this.typeMap.get(name);
            if (!type || type.isAnon) continue;
            const result = this.runDecode(this.deserializeType(type, slice.clone(), []));
            if (result.success || (name === this.lastTypeName && result.error instanceof UnsupportedAddressError))
                return result;
        }
        return {
            success: false,
            error: new TLBDataError('No matching constructor'),
        };
    }

    // Deserialize data from a Slice based on a TL-B type name
    deserializeByTypeName(typeName: string, slice: Slice, context?: ParameterContext): Result<T> {
        const type = this.typeMap.get(typeName);
        if (!type) {
            return {
                success: false,
                error: new TLBDataError(`Type ${typeName} not found in TL-B schema`),
            };
        }
        try {
            return this.runDecode(this.deserializeType(type, slice, [], undefined, context));
        } catch (error) {
            if (error instanceof DecodeDepthError || error instanceof RangeError) return { success: false, error };
            throw error;
        }
    }

    serialize(data: T): Result<Builder> {
        const typeKind = (data as TypeCell).kind;
        if (!typeKind) {
            return {
                success: false,
                error: new TLBDataError('Data must by typed'),
            };
        }
        return this.serializeByTypeName(typeKind, data);
    }

    // Serialize data to a Builder based on a TL-B type name
    serializeByTypeName(typeKind: string, data: T): Result<Builder> {
        const sep = typeKind.indexOf('_');
        const typeName = sep === -1 ? typeKind : typeKind.slice(0, sep);
        const type = this.typeMap.get(typeName);
        if (!type) {
            return {
                success: false,
                error: new UnknownKindError(`Type ${typeName} not found in TL-B schema`),
            };
        }
        const value = beginCell();
        this.serializeType(type, data, value);
        return {
            success: true,
            value,
        };
    }

    // Suspend the parent at each named type. Deep reference chains then use a heap stack.
    private runDecode<R>(first: DecodeFrame<T, R>): R {
        const stack: DecodeFrame<T>[] = [];
        const limit = this.config.maxDecodeDepth ?? 4096;
        const initialDepth = this.activeDecodeFrames;
        try {
            this.activeDecodeFrames++;
            if (this.activeDecodeFrames > limit) throw new DecodeDepthError(`Maximum decode depth (${limit}) exceeded`);
            let step = first.next();
            while (!step.done) {
                if (initialDepth + stack.length + 1 >= limit) {
                    throw new DecodeDepthError(`Maximum decode depth (${limit}) exceeded`);
                }
                stack.push(step.value);
                this.activeDecodeFrames = initialDepth + stack.length + 1;
                let child = step.value.next();
                while (child.done) {
                    stack.pop();
                    this.activeDecodeFrames--;
                    const parent = stack.at(-1);
                    if (!parent) {
                        step = first.next(child.value);
                        break;
                    }
                    child = parent.next(child.value);
                }
                if (!child.done) step = child;
            }
            return step.value;
        } finally {
            this.activeDecodeFrames = initialDepth;
        }
    }

    private *deserializeType(
        type: TLBType,
        data: Slice,
        args: TLBFieldType[] = [],
        initialVariables?: Map<string, number | bigint>,
        context?: ParameterContext,
    ): DecodeFrame<T> {
        // If type has implicit parameters and we have type arguments,
        // build a context from type arguments before trying constructors
        // This handles parametric types like Hashmap n X where (n, X) are implicit parameters
        if (args.length > 0 && type.constructors.length > 0) {
            const firstCtor = type.constructors[0];
            const implicitVars = firstCtor.variables.filter((v) => !v.negated && v.isConst === false);

            if (implicitVars.length > 0) {
                // Extend existing context or create new one
                const typeContext = context?.extend() ?? new ParameterContext();
                const evaluator = new MathExprEvaluator(initialVariables ?? new Map());

                for (let i = 0; i < Math.min(args.length, implicitVars.length); i++) {
                    const varDef = implicitVars[i];
                    const arg = args[i];

                    if (varDef.type === '#' && varDef.name) {
                        // Nat parameter
                        let natValue: number | undefined;
                        if (arg.kind === 'TLBNumberType') {
                            try {
                                natValue = evaluator.evaluate(arg.bits);
                            } catch (e) {
                                void e;
                            }
                        } else if (arg.kind === 'TLBNamedType' && context) {
                            // Try to resolve from context if it's a parameter reference
                            const resolved = context.resolveNat(arg.name);
                            if (typeof resolved === 'number') {
                                natValue = resolved;
                            }
                        }
                        if (typeof natValue === 'number') {
                            typeContext.setNat(varDef.name, natValue);
                        }
                    } else if (varDef.type === 'Type' && varDef.name) {
                        // Type parameter
                        typeContext.setType(varDef.name, arg as TLBFieldType);
                    }
                }

                // Use the type context for the rest of the deserialization
                context = typeContext;
            }
        }

        // A matching tag takes priority. Within each group, try declarations in schema order.
        const constructorsToTry = [
            ...type.constructors.filter((c) => c.tag.bitLen > 0),
            ...type.constructors.filter((c) => !c.tag.bitLen),
        ];
        const matchTags = type.constructors.length > 1;

        let lastError: Error | undefined;
        for (const constructor of constructorsToTry) {
            if (matchTags && constructor.tag.bitLen) {
                const { bitLen, binary } = constructor.tag;
                if (data.remainingBits < bitLen || data.preloadUintBig(bitLen) !== BigInt(binary)) continue;
            }
            try {
                const prev = data.clone();
                const result = yield* this.deserializeConstructor(
                    type,
                    constructor,
                    prev,
                    args,
                    initialVariables,
                    context,
                );
                if (result.success) {
                    const bitsUsed = data.remainingBits - prev.remainingBits;
                    const refsUsed = data.remainingRefs - prev.remainingRefs;

                    if (bitsUsed > 0) {
                        data.skip(bitsUsed);
                    }
                    for (let i = 0; i < refsUsed; i++) {
                        data.loadRef();
                    }

                    return result;
                }
                if (!result.success && result.error) {
                    lastError = result.error;
                }
            } catch (e) {
                if (e instanceof DecodeDepthError || e instanceof RangeError) throw e;
                // Try next constructor on failure
                if (e instanceof Error) {
                    lastError = e;
                }
            }
        }

        return {
            success: false,
            error:
                lastError ?? new TLBDataError(`Failed to deserialize type ${type.name}: no matching constructor found`),
        };
    }

    private *deserializeConstructor(
        type: TLBType,
        constructor: TLBConstructor,
        slice: Slice,
        args: TLBFieldType[] = [],
        initialVariables?: Map<string, number | bigint>,
        context?: ParameterContext,
    ): DecodeFrame<T> {
        const kind = type.constructors.length > 1 ? `${type.name}_${constructor.name}` : type.name;

        for (const [i, param] of constructor.parameters.entries()) {
            const arg = args[i];
            if (!arg || param.paramExpr?.kind !== 'TLBNumberExpr' || param.variable.negated) continue;
            const expr =
                arg.kind === 'TLBExprMathType' ? arg.initialExpr : arg.kind === 'TLBNumberType' ? arg.bits : undefined;
            if (expr && new MathExprEvaluator(initialVariables ?? new Map()).evaluate(expr) !== param.paramExpr.n) {
                return { success: false, error: new TLBDataError(`Result parameter mismatch for ${kind}`) };
            }
        }

        const { bitLen: tagBitLen, binary: tagBinary } = constructor.tag;

        // Check tag if present
        if (tagBitLen > 0) {
            const len = tagBitLen;
            if (slice.remainingBits < len) {
                return {
                    success: false,
                    error: new TLBDataError(`Not enough bits to read tag for ${kind}`),
                };
            }
            // Read tag bits from slice (consume them now since we're committed to this constructor)
            const tagValue = slice.loadUintBig(len);
            const expectedTagValue = BigInt(tagBinary);
            if (tagValue !== expectedTagValue) {
                return {
                    success: false,
                    error: new TLBDataError(
                        `Failed to deserialize type ${kind}: tag mismatch (got ${tagValue}, expected ${expectedTagValue})`,
                    ),
                };
            }
        }

        // Initialize variables map for constraint evaluation
        const variables = new Map<string, number | bigint>(initialVariables);

        // US-004: Build context from constructor parameters for parameter substitution
        // Create context chain: parent context is passed in, child context is built from constructor parameters
        let childContext = context?.extend() ?? new ParameterContext();

        // First, extract explicit Nat and Type parameters from args and add to context
        // Only process parameters that are actually provided in args
        const paramEvaluator = new MathExprEvaluator(variables);
        const resultArguments: { expression: _TLBMathExpr; expected: number }[] = [];
        let argIndex = 0;
        for (const param of constructor.parameters) {
            if (argIndex >= args.length) {
                // No more args provided - remaining params are implicit or have defaults
                break;
            }

            const arg = args[argIndex];

            if (param.variable?.type === '#') {
                // Nat parameter - evaluate and add to context
                let natValue: number | undefined;
                try {
                    if (arg.kind === 'TLBExprMathType') {
                        natValue = paramEvaluator.evaluate(arg.initialExpr);
                    } else if (arg.kind === 'TLBNumberType') {
                        natValue = paramEvaluator.evaluate(arg.bits);
                    } else if (arg.kind === 'TLBNamedType') {
                        // Parameter reference
                        const value = variables.get(arg.name) ?? context?.resolveNat(arg.name);
                        natValue = value === undefined ? undefined : safeExpressionNumber(value);
                    }
                    if (typeof natValue === 'number' && param.variable.name) {
                        const result = param.paramExpr;
                        if (
                            result &&
                            (constructor.resultParameters || (!param.variable.negated && result.kind !== 'TLBVarExpr'))
                        ) {
                            resultArguments.push({ expression: result, expected: natValue });
                        }
                        if (!result || param.variable.negated || result.kind === 'TLBVarExpr') {
                            childContext.setNat(param.variable.name, natValue);
                            variables.set(param.variable.name, natValue);
                        }
                        if (param.argName) variables.set(param.argName, natValue);
                    }
                } catch (e) {
                    void e;
                }
                argIndex++;
            } else if (param.variable?.type === 'Type') {
                // Type parameter - add to context
                if (param.variable.name) {
                    childContext.setType(param.variable.name, arg as TLBFieldType);
                }
                argIndex++;
            } else {
                // Not a parametric parameter, stop processing args
                break;
            }
        }

        // Also propagate parameters from parent context that aren't in this constructor's parameters
        if (context) {
            const allNatParams = context.getAllNatParams();
            for (const [name, value] of allNatParams) {
                if (!variables.has(name)) {
                    childContext.setNat(name, value);
                    variables.set(name, value);
                }
            }
        }

        // Add all constructor variables to the map if not already present
        // (This ensures constraints can reference parameters by name)
        // Skip implicit parameters - they should be inferred, not initialized as undefined
        for (const v of constructor.variables) {
            if (!variables.has(v.name)) {
                // Check if this is an implicit parameter
                const isImplicitParam = constructor.parameters.some(
                    (p) => p.variable?.name === v.name && p.variable.type === '#',
                );
                if (!isImplicitParam) {
                    // Initialize as undefined (using any cast since Map<string, number | bigint> doesn't like undefined)
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (variables as any).set(v.name, undefined);
                }
            }
        }

        // Add positional aliases for initial variables
        for (let i = 0; i < constructor.variables.length; i++) {
            const v = constructor.variables[i];
            const val = variables.get(v.name);
            if (val !== undefined) {
                variables.set(`_${i + 1}`, val);
            }
        }

        // Legacy compiler contexts can seed formal parameters with the raw result argument.
        // Only simple parameters are direct bindings; compound expressions must infer their operands.
        const directBindings = new Set(
            constructor.parameters
                .filter((p, i) => args[i] && p.paramExpr?.kind === 'TLBVarExpr')
                .map((p) => p.variable.name),
        );
        for (const { expression } of resultArguments) {
            for (const name of this.extractVariablesFromExpr(expression)) {
                if (!directBindings.has(name)) variables.delete(name);
            }
        }
        this.bindResultArguments(resultArguments, variables, type.name, false);
        for (const [name, value] of variables) {
            if (typeof value === 'number') childContext.setNat(name, value);
        }

        // Fallback: some schemas keep numeric variables only in `variables` and not in `parameters`.
        // In that case, bind them positionally from type arguments.
        if (args.length > 0 && constructor.parameters.length === 0 && constructor.variables.length > 0) {
            const evaluator = new MathExprEvaluator(variables);
            const numericVars = constructor.variables.filter((v) => v.type === '#');
            for (let i = 0; i < Math.min(args.length, numericVars.length); i++) {
                const v = numericVars[i];
                const arg = args[i];
                try {
                    let argValue: number | undefined;
                    if (arg.kind === 'TLBExprMathType') {
                        argValue = evaluator.evaluate(arg.initialExpr);
                    } else if (arg.kind === 'TLBNumberType') {
                        argValue = evaluator.evaluate(arg.bits);
                    }
                    if (typeof argValue === 'number') {
                        variables.set(v.name, argValue);
                    }
                } catch (error) {
                    void error;
                }
            }
        }

        // Deserialize fields
        // FIXME
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let value: any = {
            kind,
        };

        // Handle case where codegen doesn't generate fields but declaration has them
        // Example: "_ x:# = OneNatParam;" where x is a field but not generated by codegen
        if (this.compileSchema !== compileLegacySchema && constructor.fields.length === 0 && constructor.declaration) {
            // Parse declaration to extract field information
            // Format: "_ x:# = OneNatParam;" -> extract "x:#"
            // Also handle multiple fields: "_ x:# y:# = TwoNatParam;"
            // Also handle cell references: "_ x:^Cell = ParamCell;" or "_ x:^ParamCell = UseParamCell;"
            // Also handle ## n types: "_ x:(## 5) = LimitNat;" or "_ {n:#} x:(## n) = ParamType n;"
            // Also handle parameterized types: "_ x:(ParamType 4) = UseParamType;"
            // Also handle anonymous fields: "_ (## 1) = AnonymousData;" -> anon0, anon1, etc.

            let anonFieldIndex = 0; // Track anonymous field index

            // First, handle anonymous fields (fields without names) - must come before named field patterns
            // Pattern: (## n) without field name prefix
            // Example: "_ (## 1) = AnonymousData;"

            // Handle anonymous ## n types: (## 1) or (## n)
            // Match (## n) that is NOT preceded by a field name (word:)
            const declaration = constructor.declaration.replace(/\{[^}]*\}/g, '');
            const anonLimitNatMatches = Array.from(declaration.matchAll(/\(##\s*(\w+)\)/g));
            for (const match of anonLimitNatMatches) {
                // Skip if this is part of a named field (e.g., "x:(## 1)" - already handled by named patterns)
                const matchIndex = match.index!;
                const beforeMatch = declaration.substring(0, matchIndex);
                // Check if there's a field name before this match (word followed by colon)
                const beforeTrimmed = beforeMatch.trim();
                if (beforeTrimmed.endsWith(':') || /:\s*$/.test(beforeTrimmed)) {
                    // This is part of a named field, skip it (will be handled by named field patterns)
                    continue;
                }

                const bitsExpr = match[1];
                const fieldName = `anon${anonFieldIndex++}`;

                // Evaluate bits expression (could be constant number or variable name)
                let bits: number;
                if (/^\d+$/.test(bitsExpr)) {
                    // Constant: (## 1)
                    bits = parseInt(bitsExpr, 10);
                } else {
                    // Variable: (## n) - get from variables map
                    const bitsValue = variables.get(bitsExpr);
                    if (bitsValue === undefined) {
                        return {
                            success: false,
                            error: new TLBDataError(`Variable ${bitsExpr} not found for anonymous field`),
                        };
                    }
                    bits = safeExpressionNumber(bitsValue);
                }

                if (slice.remainingBits >= bits) {
                    const fieldValue = Number(slice.loadUint(bits));
                    value[fieldName] = fieldValue;
                    variables.set(fieldName, fieldValue);
                } else {
                    return {
                        success: false,
                        error: new TLBDataError(`Not enough bits to read anonymous field (need ${bits} bits)`),
                    };
                }
            }

            // First, handle numeric fields (#) - 32-bit nat
            const fieldMatches = declaration.matchAll(/(\w+):#/g);
            for (const match of fieldMatches) {
                const fieldName = match[1];
                // Deserialize as 32-bit number (type #)
                if (slice.remainingBits >= 32) {
                    const fieldValue = Number(slice.loadUint(32));
                    value[fieldName] = fieldValue;
                    variables.set(fieldName, fieldValue);
                }
            }

            // Handle ## n types: (## 5) with constant, or (## n) with variable
            // Match both constant: (## 5) and variable: (## n)
            const limitNatMatches = declaration.matchAll(/(\w+):\(##\s*(\w+)\)/g);
            for (const match of limitNatMatches) {
                const fieldName = match[1];
                const bitsExpr = match[2];

                // Evaluate bits expression (could be constant number or variable name)
                let bits: number;
                if (/^\d+$/.test(bitsExpr)) {
                    // Constant: (## 5)
                    bits = parseInt(bitsExpr, 10);
                } else {
                    // Variable: (## n) - get from variables map
                    let bitsValue = variables.get(bitsExpr);
                    if (bitsValue === undefined) {
                        // Try to infer implicit parameter from remaining bits in slice
                        // For implicit parameters like {n:#}, check if this parameter is defined in constructor.parameters
                        const implicitParam = constructor.parameters.find(
                            (p) => p.variable?.name === bitsExpr && p.variable.type === '#',
                        );
                        if (implicitParam && slice.remainingBits > 0) {
                            // Infer parameter value from remaining bits
                            // This works for simple cases where all remaining bits go to this field
                            bitsValue = slice.remainingBits;
                            variables.set(bitsExpr, bitsValue);
                        } else {
                            return {
                                success: false,
                                error: new TLBDataError(`Variable ${bitsExpr} not found for field ${fieldName}`),
                            };
                        }
                    }
                    bits = safeExpressionNumber(bitsValue);
                }

                if (slice.remainingBits >= bits) {
                    const fieldValue = Number(slice.loadUint(bits));
                    value[fieldName] = fieldValue;
                    variables.set(fieldName, fieldValue);
                } else {
                    return {
                        success: false,
                        error: new TLBDataError(`Not enough bits to read field ${fieldName} (need ${bits} bits)`),
                    };
                }
            }

            // Handle #< n and #<= n types: x:(#< 4) or x:(#<= 4)
            const lessThanMatches = declaration.matchAll(/(\w+):\((#<|#<=)\s+(\w+)\)/g);
            for (const match of lessThanMatches) {
                const fieldName = match[1];
                const typeName = match[2]; // '#<' or '#<='
                const nExpr = match[3]; // Could be constant number or variable name

                // Evaluate n
                let n: number;
                if (/^\d+$/.test(nExpr)) {
                    // Constant: (#< 4)
                    n = parseInt(nExpr, 10);
                } else {
                    // Variable: (#< n) - get from variables map
                    const nValue = variables.get(nExpr);
                    if (nValue === undefined) {
                        return {
                            success: false,
                            error: new TLBDataError(`Variable ${nExpr} not found for field ${fieldName}`),
                        };
                    }
                    n = safeExpressionNumber(nValue);
                }

                // Calculate bit width
                let bits: number;
                if (typeName === '#<') {
                    bits = MathExprEvaluator.calculateBitsForLessThan(n);
                } else {
                    bits = MathExprEvaluator.calculateBitsForLessThanOrEqual(n);
                }

                if (slice.remainingBits >= bits) {
                    const fieldValue = Number(slice.loadUint(bits));
                    value[fieldName] = fieldValue;
                    variables.set(fieldName, fieldValue);
                } else {
                    return {
                        success: false,
                        error: new TLBDataError(`Not enough bits to read field ${fieldName} (need ${bits} bits)`),
                    };
                }
            }

            // Handle int and uint types: x:int257 or x:uint256
            // Match both: int257 and uint256
            const intConstantMatches = declaration.matchAll(/(\w+):int(\d+)/g);
            for (const match of intConstantMatches) {
                const fieldName = match[1];
                const bits = parseInt(match[2], 10);
                if (slice.remainingBits >= bits) {
                    const fieldValue = this.loadBigInt(slice, bits, true); // signed
                    const maxBits = 32;
                    if (bits > maxBits) {
                        value[fieldName] = fieldValue;
                    } else {
                        value[fieldName] = Number(fieldValue);
                    }
                    if (bits <= 53) {
                        variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                    }
                } else {
                    return {
                        success: false,
                        error: new TLBDataError(`Not enough bits to read field ${fieldName} (need ${bits} bits)`),
                    };
                }
            }

            const uintConstantMatches = declaration.matchAll(/(\w+):uint(\d+)/g);
            for (const match of uintConstantMatches) {
                const fieldName = match[1];
                const bits = parseInt(match[2], 10);
                if (slice.remainingBits >= bits) {
                    const fieldValue = this.loadBigInt(slice, bits, false); // unsigned
                    const maxBits = 32;
                    if (bits > maxBits) {
                        value[fieldName] = fieldValue;
                    } else {
                        value[fieldName] = Number(fieldValue);
                    }
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                } else {
                    return {
                        success: false,
                        error: new TLBDataError(`Not enough bits to read field ${fieldName} (need ${bits} bits)`),
                    };
                }
            }

            // Handle parameterized int types: x:(int (e * 8)) or x:(int n)
            const intExprMatches = declaration.matchAll(/(\w+):\(int\s+([^)]+)\)/g);
            for (const match of intExprMatches) {
                const fieldName = match[1];
                const bitsExpr = match[2].trim();

                // Evaluate bits expression (could be constant number, variable name, or expression)
                let bits: number;
                if (/^\d+$/.test(bitsExpr)) {
                    // Constant: (int 257)
                    bits = parseInt(bitsExpr, 10);
                } else {
                    // Try to evaluate as math expression
                    try {
                        // Parse simple expressions like "e * 8" or "n + 1"
                        if (
                            bitsExpr.includes('+') ||
                            bitsExpr.includes('-') ||
                            bitsExpr.includes('*') ||
                            bitsExpr.includes('/')
                        ) {
                            const parts = bitsExpr.split(/([+\-*/])/);
                            let result = 0;
                            let op = '+';
                            for (const part of parts) {
                                const trimmed = part.trim();
                                if (trimmed === '+' || trimmed === '-' || trimmed === '*' || trimmed === '/') {
                                    op = trimmed;
                                } else if (/^\d+$/.test(trimmed)) {
                                    const num = parseInt(trimmed, 10);
                                    if (op === '+') result += num;
                                    else if (op === '-') result -= num;
                                    else if (op === '*') result *= num;
                                    else if (op === '/') result = Math.floor(result / num);
                                } else {
                                    // Variable name
                                    const varValue = variables.get(trimmed);
                                    if (varValue === undefined) {
                                        return {
                                            success: false,
                                            error: new TLBDataError(
                                                `Variable ${trimmed} not found for field ${fieldName}`,
                                            ),
                                        };
                                    }
                                    if (op === '+') result += safeExpressionNumber(varValue);
                                    else if (op === '-') result -= safeExpressionNumber(varValue);
                                    else if (op === '*') result *= safeExpressionNumber(varValue);
                                    else if (op === '/') result = Math.floor(result / safeExpressionNumber(varValue));
                                }
                            }
                            bits = result;
                        } else {
                            // Single variable name
                            const varValue = variables.get(bitsExpr);
                            if (varValue === undefined) {
                                return {
                                    success: false,
                                    error: new TLBDataError(`Variable ${bitsExpr} not found for field ${fieldName}`),
                                };
                            }
                            bits = safeExpressionNumber(varValue);
                        }
                    } catch (_error) {
                        return {
                            success: false,
                            error: new TLBDataError(
                                `Failed to evaluate bits expression for field ${fieldName}: ${bitsExpr}`,
                            ),
                        };
                    }
                }

                if (slice.remainingBits >= bits) {
                    const fieldValue = this.loadBigInt(slice, bits, true); // signed
                    const maxBits = 32;
                    if (bits > maxBits) {
                        value[fieldName] = fieldValue;
                    } else {
                        value[fieldName] = Number(fieldValue);
                    }
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                } else {
                    return {
                        success: false,
                        error: new TLBDataError(`Not enough bits to read field ${fieldName} (need ${bits} bits)`),
                    };
                }
            }

            // Handle parameterized uint types: x:(uint (7 * e)) or x:(uint n)
            const uintExprMatches = declaration.matchAll(/(\w+):\(uint\s+([^)]+)\)/g);
            for (const match of uintExprMatches) {
                const fieldName = match[1];
                const bitsExpr = match[2].trim();

                // Evaluate bits expression (could be constant number, variable name, or expression)
                let bits: number;
                if (/^\d+$/.test(bitsExpr)) {
                    // Constant: (uint 256)
                    bits = parseInt(bitsExpr, 10);
                } else {
                    // Try to evaluate as math expression
                    try {
                        // Parse simple expressions like "7 * e" or "n + 1"
                        if (
                            bitsExpr.includes('+') ||
                            bitsExpr.includes('-') ||
                            bitsExpr.includes('*') ||
                            bitsExpr.includes('/')
                        ) {
                            const parts = bitsExpr.split(/([+\-*/])/);
                            let result = 0;
                            let op = '+';
                            for (const part of parts) {
                                const trimmed = part.trim();
                                if (trimmed === '+' || trimmed === '-' || trimmed === '*' || trimmed === '/') {
                                    op = trimmed;
                                } else if (/^\d+$/.test(trimmed)) {
                                    const num = parseInt(trimmed, 10);
                                    if (op === '+') result += num;
                                    else if (op === '-') result -= num;
                                    else if (op === '*') result *= num;
                                    else if (op === '/') result = Math.floor(result / num);
                                } else {
                                    // Variable name
                                    const varValue = variables.get(trimmed);
                                    if (varValue === undefined) {
                                        return {
                                            success: false,
                                            error: new TLBDataError(
                                                `Variable ${trimmed} not found for field ${fieldName}`,
                                            ),
                                        };
                                    }
                                    if (op === '+') result += safeExpressionNumber(varValue);
                                    else if (op === '-') result -= safeExpressionNumber(varValue);
                                    else if (op === '*') result *= safeExpressionNumber(varValue);
                                    else if (op === '/') result = Math.floor(result / safeExpressionNumber(varValue));
                                }
                            }
                            bits = result;
                        } else {
                            // Single variable name
                            const varValue = variables.get(bitsExpr);
                            if (varValue === undefined) {
                                return {
                                    success: false,
                                    error: new TLBDataError(`Variable ${bitsExpr} not found for field ${fieldName}`),
                                };
                            }
                            bits = safeExpressionNumber(varValue);
                        }
                    } catch (_error) {
                        return {
                            success: false,
                            error: new TLBDataError(
                                `Failed to evaluate bits expression for field ${fieldName}: ${bitsExpr}`,
                            ),
                        };
                    }
                }

                if (slice.remainingBits >= bits) {
                    const fieldValue = this.loadBigInt(slice, bits, false); // unsigned
                    const maxBits = 32;
                    if (bits > maxBits) {
                        value[fieldName] = fieldValue;
                    } else {
                        value[fieldName] = Number(fieldValue);
                    }
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                } else {
                    return {
                        success: false,
                        error: new TLBDataError(`Not enough bits to read field ${fieldName} (need ${bits} bits)`),
                    };
                }
            }

            // Handle bits types: x:bits256 or x:(bits (5 + e))
            // Match both constant: bits256 and expression: (bits (5 + e))
            const bitsConstantMatches = declaration.matchAll(/(\w+):bits(\d+)/g);
            for (const match of bitsConstantMatches) {
                const fieldName = match[1];
                const bits = parseInt(match[2], 10);
                if (slice.remainingBits >= bits) {
                    value[fieldName] = decodeBits(slice.loadBits(bits), this.config.autoText);
                } else {
                    return {
                        success: false,
                        error: new TLBDataError(`Not enough bits to read field ${fieldName} (need ${bits} bits)`),
                    };
                }
            }

            // Handle bits with expression: (bits (5 + e))
            const bitsExprMatches = declaration.matchAll(/(\w+):\(bits\s+([^)]+)\)/g);
            for (const match of bitsExprMatches) {
                const fieldName = match[1];
                const bitsExpr = match[2].trim();

                // Evaluate bits expression (could be constant number, variable name, or expression)
                let bits: number;
                if (/^\d+$/.test(bitsExpr)) {
                    // Constant: (bits 256)
                    bits = parseInt(bitsExpr, 10);
                } else {
                    // Try to evaluate as math expression
                    try {
                        // Parse simple expressions like "5 + e" or "len * 8"
                        // For now, handle simple cases - if it contains +, -, *, /, evaluate it
                        if (
                            bitsExpr.includes('+') ||
                            bitsExpr.includes('-') ||
                            bitsExpr.includes('*') ||
                            bitsExpr.includes('/')
                        ) {
                            // Simple expression parsing - split by operators and evaluate
                            // This is a simplified parser - for complex expressions, the fieldType conversion should handle it
                            const parts = bitsExpr.split(/([+\-*/])/);
                            let result = 0;
                            let op = '+';
                            for (const part of parts) {
                                const trimmed = part.trim();
                                if (trimmed === '+' || trimmed === '-' || trimmed === '*' || trimmed === '/') {
                                    op = trimmed;
                                } else if (/^\d+$/.test(trimmed)) {
                                    const num = parseInt(trimmed, 10);
                                    if (op === '+') result += num;
                                    else if (op === '-') result -= num;
                                    else if (op === '*') result *= num;
                                    else if (op === '/') result = Math.floor(result / num);
                                } else {
                                    // Variable name
                                    const varValue = variables.get(trimmed);
                                    if (varValue === undefined) {
                                        return {
                                            success: false,
                                            error: new TLBDataError(
                                                `Variable ${trimmed} not found for field ${fieldName}`,
                                            ),
                                        };
                                    }
                                    if (op === '+') result += safeExpressionNumber(varValue);
                                    else if (op === '-') result -= safeExpressionNumber(varValue);
                                    else if (op === '*') result *= safeExpressionNumber(varValue);
                                    else if (op === '/') result = Math.floor(result / safeExpressionNumber(varValue));
                                }
                            }
                            bits = result;
                        } else {
                            // Single variable name
                            const varValue = variables.get(bitsExpr);
                            if (varValue === undefined) {
                                return {
                                    success: false,
                                    error: new TLBDataError(`Variable ${bitsExpr} not found for field ${fieldName}`),
                                };
                            }
                            bits = safeExpressionNumber(varValue);
                        }
                    } catch (_error) {
                        return {
                            success: false,
                            error: new TLBDataError(
                                `Failed to evaluate bits expression for field ${fieldName}: ${bitsExpr}`,
                            ),
                        };
                    }
                }

                if (slice.remainingBits >= bits) {
                    value[fieldName] = decodeBits(slice.loadBits(bits), this.config.autoText);
                } else {
                    return {
                        success: false,
                        error: new TLBDataError(`Not enough bits to read field ${fieldName} (need ${bits} bits)`),
                    };
                }
            }

            // Handle uint and int with expression: (uint (len * 8)) or (int (len * 8))
            const numericExprMatches = declaration.matchAll(/(\w+):\((uint|int)\s+\(([^)]+)\)\)/g);
            for (const match of numericExprMatches) {
                const fieldName = match[1];
                const numericType = match[2]; // 'uint' or 'int'
                const bitsExpr = match[3].trim();

                // Evaluate bits expression (could be constant number, variable name, or expression)
                let bits: number;
                if (/^\d+$/.test(bitsExpr)) {
                    // Constant: (uint (256))
                    bits = parseInt(bitsExpr, 10);
                } else {
                    // Try to evaluate as math expression
                    try {
                        // Parse simple expressions like "5 + e" or "len * 8"
                        if (
                            bitsExpr.includes('+') ||
                            bitsExpr.includes('-') ||
                            bitsExpr.includes('*') ||
                            bitsExpr.includes('/')
                        ) {
                            // Simple expression parsing - split by operators and evaluate
                            const parts = bitsExpr.split(/([+\-*/])/);
                            let result = 0;
                            let op = '+';
                            for (const part of parts) {
                                const trimmed = part.trim();
                                if (trimmed === '+' || trimmed === '-' || trimmed === '*' || trimmed === '/') {
                                    op = trimmed;
                                } else if (/^\d+$/.test(trimmed)) {
                                    const num = parseInt(trimmed, 10);
                                    if (op === '+') result += num;
                                    else if (op === '-') result -= num;
                                    else if (op === '*') result *= num;
                                    else if (op === '/') result = Math.floor(result / num);
                                } else {
                                    // Variable name
                                    const varValue = variables.get(trimmed);
                                    if (varValue === undefined) {
                                        return {
                                            success: false,
                                            error: new TLBDataError(
                                                `Variable ${trimmed} not found for field ${fieldName}`,
                                            ),
                                        };
                                    }
                                    if (op === '+') result += safeExpressionNumber(varValue);
                                    else if (op === '-') result -= safeExpressionNumber(varValue);
                                    else if (op === '*') result *= safeExpressionNumber(varValue);
                                    else if (op === '/') result = Math.floor(result / safeExpressionNumber(varValue));
                                }
                            }
                            bits = result;
                        } else {
                            // Single variable name
                            const varValue = variables.get(bitsExpr);
                            if (varValue === undefined) {
                                return {
                                    success: false,
                                    error: new TLBDataError(`Variable ${bitsExpr} not found for field ${fieldName}`),
                                };
                            }
                            bits = safeExpressionNumber(varValue);
                        }
                    } catch (_error) {
                        return {
                            success: false,
                            error: new TLBDataError(
                                `Failed to evaluate bits expression for field ${fieldName}: ${bitsExpr}`,
                            ),
                        };
                    }
                }

                if (slice.remainingBits >= bits) {
                    const fieldValue = this.loadBigInt(slice, bits, numericType === 'int');
                    const maxBits = 32;
                    if (bits > maxBits) {
                        value[fieldName] = fieldValue;
                        if (bits <= 53) {
                            variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                        }
                    } else {
                        const numValue = Number(fieldValue);
                        value[fieldName] = numValue;
                        variables.set(fieldName, numValue);
                    }
                } else {
                    return {
                        success: false,
                        error: new TLBDataError(`Not enough bits to read field ${fieldName} (need ${bits} bits)`),
                    };
                }
            }

            // Handle parameterized types: x:(ParamType 4) or x:(ExprType 6)
            // Pattern: fieldName:(TypeName arg1 arg2 ...) - must handle nested parentheses in args
            // For now, manually match to handle nested parentheses
            const paramTypeMatches: Array<{ fieldName: string; typeName: string; argsStr: string; index: number }> = [];
            const paramTypeRegex = /(\w+):\((\w+)/g;
            let paramMatch;
            while ((paramMatch = paramTypeRegex.exec(declaration)) !== null) {
                const fieldName = paramMatch[1];
                const typeName = paramMatch[2];
                const startIndex = paramMatch.index + paramMatch[0].length;

                // Check if this has already been handled by other patterns
                if (typeName === '##' || typeName === '#<' || typeName === '#<=' || typeName === 'bits') {
                    continue;
                }

                // Find matching closing parenthesis, handling nested parentheses
                let parenDepth = 1;
                let endIndex = startIndex;
                for (; endIndex < declaration.length && parenDepth > 0; endIndex++) {
                    if (declaration[endIndex] === '(') {
                        parenDepth++;
                    } else if (declaration[endIndex] === ')') {
                        parenDepth--;
                    }
                }

                if (parenDepth === 0) {
                    const argsStr = declaration.substring(startIndex, endIndex - 1).trim();
                    paramTypeMatches.push({ fieldName, typeName, argsStr, index: paramMatch.index });
                }
            }

            for (const match of paramTypeMatches) {
                const fieldName = match.fieldName;
                const typeName = match.typeName;
                const argsStr = match.argsStr;

                const type = this.typeMap.get(typeName);
                if (!type) {
                    return {
                        success: false,
                        error: new TLBDataError(`Type ${typeName} not found for field ${fieldName}`),
                    };
                }

                // Parse type arguments (e.g., "4" from "(ParamType 4)" or "A" from "(Maybe A)" or "^OptionType" from "(HashmapE 100 ^OptionType)")
                const args: TLBFieldType[] = [];
                if (argsStr.trim()) {
                    // Split arguments by whitespace, but be careful with expressions like "(n+2)"
                    // First, handle expressions in parentheses separately
                    let remaining = argsStr.trim();
                    while (remaining.length > 0) {
                        remaining = remaining.trim();
                        if (!remaining) break;

                        // Check if it starts with a parenthesis (expression like "(n+2)")
                        if (remaining.startsWith('(')) {
                            // Find matching closing parenthesis
                            let depth = 0;
                            let i = 0;
                            for (; i < remaining.length; i++) {
                                if (remaining[i] === '(') depth++;
                                else if (remaining[i] === ')') {
                                    depth--;
                                    if (depth === 0) break;
                                }
                            }
                            if (depth !== 0) {
                                // Unmatched parentheses - treat as type name
                                const spaceIdx = remaining.indexOf(' ');
                                const argPart = spaceIdx >= 0 ? remaining.substring(0, spaceIdx) : remaining;
                                args.push({
                                    kind: 'TLBNamedType',
                                    name: argPart,
                                    arguments: [],
                                });
                                remaining = spaceIdx >= 0 ? remaining.substring(spaceIdx + 1) : '';
                                continue;
                            }

                            // Extract expression inside parentheses (e.g., "n+2" from "(n+2)")
                            const exprStr = remaining.substring(1, i);
                            remaining = remaining.substring(i + 1).trim();

                            // Try to parse as arithmetic expression
                            // Simple parser for expressions like "n+2", "n*2", "2+n", etc.
                            const exprMatch = exprStr.match(
                                /^([a-z_][a-zA-Z0-9_]*|\d+)\s*([+\-*/])\s*([a-z_][a-zA-Z0-9_]*|\d+)$/,
                            );
                            if (exprMatch) {
                                const left = exprMatch[1];
                                const op = exprMatch[2];
                                const right = exprMatch[3];

                                // Convert to MathExpr structure
                                const leftExpr: Parameters<MathExprEvaluator['evaluate']>[0] = /^\d+$/.test(left)
                                    ? { kind: 'TLBNumberExpr', n: parseInt(left, 10) }
                                    : { kind: 'TLBVarExpr', x: left };

                                const rightExpr: Parameters<MathExprEvaluator['evaluate']>[0] = /^\d+$/.test(right)
                                    ? { kind: 'TLBNumberExpr', n: parseInt(right, 10) }
                                    : { kind: 'TLBVarExpr', x: right };

                                // Convert to TLBExprMathType
                                args.push({
                                    kind: 'TLBExprMathType',
                                    initialExpr: {
                                        kind: 'TLBBinaryOp',
                                        operation: op as '+' | '-' | '*' | '/',
                                        left: leftExpr,
                                        right: rightExpr,
                                    } as Parameters<MathExprEvaluator['evaluate']>[0],
                                } as TLBFieldType);
                            } else {
                                // Not a simple expression - might be just a parameter or number
                                if (/^\d+$/.test(exprStr)) {
                                    const argValue = parseInt(exprStr, 10);
                                    args.push({
                                        kind: 'TLBNumberType',
                                        bits: { kind: 'TLBNumberExpr', n: argValue },
                                        signed: false,
                                    });
                                } else {
                                    // Treat as parameter reference
                                    args.push({
                                        kind: 'TLBNamedType',
                                        name: exprStr,
                                        arguments: [],
                                    });
                                }
                            }
                            continue;
                        }

                        // Not starting with parenthesis - split by whitespace
                        const spaceIdx = remaining.indexOf(' ');
                        const argPart = spaceIdx >= 0 ? remaining.substring(0, spaceIdx) : remaining;
                        remaining = spaceIdx >= 0 ? remaining.substring(spaceIdx + 1) : '';

                        // Check if it's a cell reference (e.g., "^OptionType")
                        if (argPart.startsWith('^')) {
                            const refTypeName = argPart.substring(1);
                            args.push({
                                kind: 'TLBRefType',
                                value: {
                                    kind: 'TLBNamedType',
                                    name: refTypeName,
                                    arguments: [],
                                },
                            });
                        } else if (/^\d+$/.test(argPart)) {
                            // It's a numeric argument (e.g., "4")
                            const argValue = parseInt(argPart, 10);
                            args.push({
                                kind: 'TLBNumberType',
                                bits: { kind: 'TLBNumberExpr', n: argValue },
                                signed: false,
                            });
                        } else if (/^[a-z_][a-zA-Z0-9_]*$/.test(argPart)) {
                            // It's a parameter reference or type name
                            // Check if it's in variables map, if so treat as parameter, otherwise as type name
                            if (variables.has(argPart)) {
                                // It's a parameter - create TLBNamedType for parameter reference
                                args.push({
                                    kind: 'TLBNamedType',
                                    name: argPart,
                                    arguments: [],
                                });
                            } else {
                                // It's a type name argument (e.g., "A" from "(Maybe A)")
                                args.push({
                                    kind: 'TLBNamedType',
                                    name: argPart,
                                    arguments: [],
                                });
                            }
                        } else {
                            // Unknown format - treat as type name
                            args.push({
                                kind: 'TLBNamedType',
                                name: argPart,
                                arguments: [],
                            });
                        }
                    }
                }

                // Deserialize the parameterized type
                // For parameterized types like Maybe X, we need to pass the type arguments
                // Use deserializeFieldType with TLBNamedType that includes the arguments
                const fieldType: TLBFieldType = {
                    kind: 'TLBNamedType',
                    name: typeName,
                    arguments: args,
                };
                const fieldValue = yield* this.deserializeFieldType(
                    fieldType,
                    slice,
                    variables,
                    constructor,
                    args,
                    childContext,
                );
                value[fieldName] = fieldValue;

                // Add the field value to variables if it's numeric (for use in subsequent expressions)
                if (typeof fieldValue === 'number') {
                    variables.set(fieldName, fieldValue);
                }
            }

            // Handle inline cell references: ^[ field:Type ... ]
            // Pattern: fieldName:^[ ... ] where ... contains field definitions
            // Example: "q:^[ q:# ]" or "x:^[ a:(## 32) ^[ e:# ] ]"
            // Need to handle nested brackets properly
            let declRemaining = declaration;
            while (declRemaining.length > 0) {
                const inlineRefMatch = declRemaining.match(/(\w+):\^\[/);
                if (!inlineRefMatch) {
                    break;
                }

                const fieldName = inlineRefMatch[1];
                const matchIndex = inlineRefMatch.index!;

                // Find the matching closing bracket, handling nested brackets
                let bracketCount = 0;
                let i = matchIndex + inlineRefMatch[0].length;
                let found = false;
                for (; i < declRemaining.length; i++) {
                    if (declRemaining[i] === '[') bracketCount++;
                    else if (declRemaining[i] === ']') {
                        if (bracketCount === 0) {
                            found = true;
                            break;
                        }
                        bracketCount--;
                    }
                }

                if (!found) {
                    break;
                }

                // Extract the content inside ^[ ... ]
                const inlineFieldsStr = declRemaining.substring(matchIndex + inlineRefMatch[0].length, i);

                if (slice.remainingRefs === 0) {
                    return {
                        success: false,
                        error: new TLBDataError(`No more references available for field ${fieldName}`),
                    };
                }

                const ref = slice.loadRef();
                const refSlice = ref.beginParse(true);

                // Parse the inline fields from the string (e.g., "q:#" or "a:(## 32) ^[ e:# ] ^[ b:(## 32) d:# ^[ c:(## 32) ] ]")
                // Recursively deserialize the inline cell structure
                const inlineResult = this.deserializeInlineCell(inlineFieldsStr, refSlice, variables);
                if (inlineResult.success) {
                    value[fieldName] = inlineResult.value;
                } else {
                    return inlineResult;
                }

                // Move past this inline cell reference
                declRemaining = declRemaining.substring(i + 1);
            }

            // Handle cell references: ^Cell or ^TypeName
            const cellRefMatches = declaration.matchAll(/(\w+):\^(\w+)/g);
            for (const match of cellRefMatches) {
                const fieldName = match[1];
                const refTypeName = match[2];

                if (slice.remainingRefs === 0) {
                    return {
                        success: false,
                        error: new TLBDataError(`No more references available for field ${fieldName}`),
                    };
                }

                const ref = slice.loadRef();

                if (refTypeName === 'Cell') {
                    // ^Cell - just return the cell
                    value[fieldName] = ref;
                } else {
                    // ^TypeName - deserialize the type from the reference
                    const type = this.typeMap.get(refTypeName);
                    if (type) {
                        const refSlice = ref.beginParse(true);
                        const result = yield this.deserializeType(type, refSlice, [], variables);
                        if (result.success) {
                            value[fieldName] = result.value;
                        } else {
                            return result;
                        }
                    } else {
                        return {
                            success: false,
                            error: new TLBDataError(`Type ${refTypeName} not found for field ${fieldName}`),
                        };
                    }
                }
            }

            // Handle simple type names: x:Bool (without parentheses)
            // Pattern: fieldName:TypeName (but not fieldName:#, fieldName:bits256, fieldName:int257, etc.)
            // Only match known type names that aren't already handled by other patterns
            const simpleTypeMatches = declaration.matchAll(/(\w+):([A-Z][a-zA-Z0-9_]*)/g);
            for (const match of simpleTypeMatches) {
                const fieldName = match[1];
                const typeName = match[2];

                // Skip if this is part of a parameterized type (e.g., "x:(ParamType 4)" - already handled)
                const beforeMatch = declaration.substring(0, match.index!);
                if (beforeMatch.endsWith('(')) {
                    continue;
                }

                // Skip if this is part of a cell reference (e.g., "x:^Cell" - already handled)
                if (beforeMatch.endsWith('^')) {
                    continue;
                }

                // Handle Bool type
                if (typeName === 'Bool') {
                    if (slice.remainingBits >= 1) {
                        const bit = slice.loadBit();
                        value[fieldName] = bit === true;
                    } else {
                        return {
                            success: false,
                            error: new TLBDataError(`Not enough bits to read field ${fieldName} (need 1 bit for Bool)`),
                        };
                    }
                    continue;
                }

                // Handle MsgAddress types: MsgAddress, MsgAddressInt, MsgAddressExt
                if (typeName === 'MsgAddress' || typeName === 'MsgAddressInt' || typeName === 'MsgAddressExt') {
                    value[fieldName] = readAddress(slice, typeName);
                    continue;
                }

                // For other simple types, try to find the type and deserialize it
                const type = this.typeMap.get(typeName);
                if (type) {
                    const result = yield this.deserializeType(type, slice, [], variables);
                    if (result.success) {
                        value[fieldName] = result.value;
                    } else {
                        return result;
                    }
                }
            }
        }

        // Track anonymous field index for fields without names
        let anonFieldIndex = 0;

        // Set up initial positional aliases for constructor variables (e.g., _1 for first, _2 for second, etc.)
        // This allows constraints to reference variables by position using _1, _2, etc.
        // Note: we only set positional aliases for variables that ALREADY have values at this point
        // This prevents the constraint solver from thinking undefined variables are already defined
        for (let i = 0; i < constructor.variables.length; i++) {
            const v = constructor.variables[i];
            const val = variables.get(v.name);
            if (val !== undefined) {
                variables.set(`_${i + 1}`, val);
            }
        }

        const computedImplicitValues = new Map<string, number | bigint>();
        const solveConstraints = () =>
            this.solveConstraints(constructor.constraints, variables, (name, n) => {
                computedImplicitValues.set(name, n);
                childContext.setNat(name, n);
            });
        const bindOutput = (name: string, n: number) => {
            const previous = variables.get(name);
            if (previous !== undefined && BigInt(previous) !== BigInt(n))
                throw new TLBDataError(`Conflicting output parameter ${name}`);
            variables.set(name, n);
            childContext.setNat(name, n);
        };
        solveConstraints();
        const finishField = (field: TLBField, fieldName: string) => {
            // A reference changes the wire location but preserves the result arguments of its type.
            let resultType = field.fieldType;
            while (resultType.kind === 'TLBRefType' || resultType.kind === 'TLBCellInsideType') {
                resultType = resultType.value;
            }
            if (
                resultType.kind === 'TLBNamedType' &&
                typeof value[fieldName] === 'object' &&
                value[fieldName] !== null
            ) {
                for (let k = 0; k < resultType.arguments.length; k++) {
                    const arg = resultType.arguments[k];
                    const resVal = this.resultArgs.get(value[fieldName])?.[k];

                    if (typeof resVal === 'number') {
                        let expr: any; // eslint-disable-line @typescript-eslint/no-explicit-any
                        if (arg.kind === 'TLBExprMathType') {
                            expr = arg.initialExpr;
                        } else if (arg.kind === 'TLBNumberType') {
                            expr = arg.bits;
                        }

                        if (arg.kind === 'TLBNegatedType') {
                            bindOutput(arg.variableName, resVal);
                        }
                        if (expr) {
                            // Handle simple variable binding: ~var or var
                            let varName: string | undefined;
                            if (expr.kind === 'TLBVarExpr') {
                                varName = expr.x;
                            } else if (
                                expr.kind === 'TLBUnaryOp' &&
                                expr.operation === '~' &&
                                expr.value.kind === 'TLBVarExpr'
                            ) {
                                varName = expr.value.x;
                            }

                            if (varName) {
                                // Map positional aliases (e.g. _3) back to actual variable names (e.g. l)
                                let actualVarName = varName;
                                if (varName.startsWith('_')) {
                                    const idx = parseInt(varName.substring(1), 10);
                                    if (!isNaN(idx) && idx >= 1 && idx <= constructor.variables.length) {
                                        actualVarName = constructor.variables[idx - 1].name;
                                    }
                                }
                                bindOutput(actualVarName, resVal);
                            }
                        }
                    }
                }
            }

            if (resultArguments.length) this.bindResultArguments(resultArguments, variables, type.name, false);
            // Phase 3: Interleave constraint evaluation after each field
            // This allows computed values to be available for subsequent field arguments
            solveConstraints();

            // Update positional aliases after evaluating constraints
            // This ensures _4 (for m) gets updated if m was just computed
            for (let i = 0; i < constructor.variables.length; i++) {
                const v = constructor.variables[i];
                const val = variables.get(v.name);
                if (val !== undefined) {
                    variables.set(`_${i + 1}`, val);
                }
            }
        };
        const readField = (field: TLBField, source: Slice) =>
            this.deserializeField(field, source, variables, constructor, args, childContext);
        function* readReferencedFields(fields: TLBField[], source: Slice): DecodeFrame<T, void> {
            for (const field of fields) {
                if (field.implicit) continue;
                if (field.subFields.length) {
                    yield* readReferencedFields(field.subFields, source.loadRef().beginParse());
                } else {
                    const name = field.name || `anon${anonFieldIndex++}`;
                    value[name] = yield* readField(field, source);
                    finishField(field, name);
                }
            }
        }

        for (const field of constructor.fields) {
            // Determine field name: use provided name or generate anon0, anon1, etc. for anonymous fields
            const fieldName = field.name || `anon${anonFieldIndex++}`;

            if (field.implicit) {
                // Skip implicit fields in slice loading - they are handled as variables/parameters
                continue;
            }

            // field.subFields.length
            if (field.subFields.length > 0) {
                if (slice.remainingRefs === 0) {
                    return {
                        success: false,
                        error: new TLBDataError(`No more references available for field ${fieldName}`),
                    };
                }
                const ref = slice.loadRef();

                if (!field.name) {
                    yield* readReferencedFields(field.subFields, ref.beginParse());
                    continue;
                }

                // Special case: if we have only one subfield, handle it directly
                if (field.subFields.length === 1) {
                    const subfield = field.subFields[0];
                    if (subfield.fieldType.kind === 'TLBCellType') {
                        // ^Cell - just return the cell
                        value[fieldName] = ref;
                    } else if (subfield.fieldType.kind === 'TLBNamedType') {
                        // ^SomeType - deserialize the type from the reference
                        const refSlice = ref.beginParse(true);
                        const type = this.typeMap.get(subfield.fieldType.name);
                        if (type) {
                            // Seed nested variables from type arguments where possible
                            let initialSeed: Map<string, number | bigint> | undefined;
                            if (type.constructors.length > 0) {
                                const nestedCtor = type.constructors[0];
                                const evaluator = new MathExprEvaluator(variables);
                                const forwardedArgs = subfield.fieldType.arguments ?? [];
                                const merged = new Map<string, number | bigint>(variables);
                                if (nestedCtor.parameters.length > 0) {
                                    for (
                                        let i = 0;
                                        i < Math.min(forwardedArgs.length, nestedCtor.parameters.length);
                                        i++
                                    ) {
                                        const param = nestedCtor.parameters[i];
                                        const arg = forwardedArgs[i];
                                        try {
                                            let argValue: number | undefined;
                                            if (arg.kind === 'TLBExprMathType') {
                                                argValue = evaluator.evaluate(arg.initialExpr);
                                            } else if (arg.kind === 'TLBNumberType') {
                                                argValue = evaluator.evaluate(arg.bits);
                                            }
                                            if (
                                                typeof argValue === 'number' &&
                                                param.variable.type === '#' &&
                                                !param.variable.negated
                                            ) {
                                                merged.set(param.variable.name, argValue);
                                            }
                                        } catch (error) {
                                            void error;
                                        }
                                    }
                                    initialSeed = merged;
                                }
                            }

                            const result = yield this.deserializeType(
                                type,
                                refSlice,
                                subfield.fieldType.arguments,
                                initialSeed,
                            );
                            if (result.success) {
                                value[fieldName] = result.value;
                            } else {
                                return result;
                            }
                        } else {
                            return {
                                success: false,
                                error: new TLBDataError(`Type ${subfield.fieldType.name} not found`),
                            };
                        }
                    } else {
                        // Other single subfield types
                        const refSlice = ref.beginParse(true);
                        value[fieldName] = yield* this.deserializeField(
                            subfield,
                            refSlice,
                            variables,
                            constructor,
                            args,
                            childContext,
                        );
                    }
                } else {
                    const refSlice = ref.beginParse(true);
                    // FIXME

                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const subfields: any = {};
                    for (const subfield of field.subFields) {
                        const subfieldName = subfield.name || `anon${anonFieldIndex++}`;
                        subfields[subfieldName] = yield* this.deserializeField(
                            subfield,
                            refSlice,
                            variables,
                            constructor,
                            args,
                            childContext,
                        );
                    }

                    value[fieldName] = subfields;
                }
            } else {
                value[fieldName] = yield* this.deserializeField(
                    field,
                    slice,
                    variables,
                    constructor,
                    args,
                    childContext,
                );

                finishField(field, fieldName);
            }
        }

        // Compute derived parameter variables that depend on already deserialized fields
        if (constructor.parameters.length > 0) {
            for (const param of constructor.parameters) {
                try {
                    if (
                        param.variable?.name &&
                        param.variable.deriveExpr &&
                        variables.get(param.variable.name) === undefined
                    ) {
                        const derived = new MathExprEvaluator(variables).evaluate(param.variable.deriveExpr);
                        variables.set(param.variable.name, derived);
                    }
                } catch (error) {
                    void error;
                }
            }
        }

        if (constructor.variables.length > 0) {
            for (const v of constructor.variables) {
                if (v.type === '#' && !v.negated && !v.isConst && variables.get(v.name) === undefined) {
                    // Load from initialVariables if provided (passed from parent)
                    if (initialVariables && initialVariables.has(v.name)) {
                        const val = initialVariables.get(v.name);
                        if (typeof val === 'number') {
                            variables.set(v.name, val);
                            continue;
                        }
                    }
                    // Else, try to get value from the deserialized value object (might have been computed from nested types)
                    const val = (value as Record<string, unknown>)[v.name];
                    if (typeof val === 'number') {
                        variables.set(v.name, val);
                        continue;
                    }
                }
            }
        }

        // Add or update positional aliases for all variables after field loading
        // Add or update positional aliases for all variables after field loading
        for (let i = 0; i < constructor.variables.length; i++) {
            const v = constructor.variables[i];
            let val = variables.get(v.name);

            // If named variable is missing, check if we have it under positional alias
            // This happens when implicit parameters are passed as arguments (e.g. ~l becoming _1)
            if (val === undefined) {
                val = variables.get(`_${i + 1}`);
                if (val !== undefined) {
                    variables.set(v.name, val);
                }
            }

            if (val !== undefined) {
                variables.set(`_${i + 1}`, val);
            }
        }

        // Check constraints and compute implicit values
        const evaluator = new MathExprEvaluator(variables);
        solveConstraints();
        this.bindResultArguments(resultArguments, variables, type.name);
        for (const constraint of constructor.constraints) {
            try {
                const result = evaluator.evaluate(constraint);
                // Validate constraint: should evaluate to 1 (true)
                if (result !== 1) {
                    return {
                        success: false,
                        error: new TLBDataError(`Failed to deserialize type ${kind} due to constraint violation`),
                    };
                }
            } catch (error) {
                // If evaluation fails, treat as constraint violation
                return {
                    success: false,
                    error: new TLBDataError(
                        `Failed to evaluate constraint for type ${kind}: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                };
            }
        }

        // Create final result object with normalized property order
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const orderedValue: any = type.isAnon ? {} : { kind };
        const addedNames = new Set<string>(['kind']);

        // 1. Add regular fields in schema order (PRIORITY: Preserves types like BigInt, Boolean)
        let anonIdx = 0;
        for (const field of constructor.fields) {
            if (field.implicit) continue;
            const fieldName = field.name || `anon${anonIdx++}`;
            const fieldValue = (value as Record<string, unknown>)[fieldName];
            if (fieldValue !== undefined) {
                orderedValue[fieldName] = fieldValue;
                addedNames.add(fieldName);
            }
        }

        // 2. Add computed implicit values and map positional aliases back to names
        for (const [varName, varValue] of computedImplicitValues) {
            // Skip internal result variables
            if (varName.startsWith('_res')) continue;

            let nameToSet = varName;
            if (varName.startsWith('_')) {
                const idx = parseInt(varName.substring(1), 10);
                if (!isNaN(idx) && idx >= 1 && idx <= constructor.variables.length) {
                    nameToSet = constructor.variables[idx - 1].name;
                }
            }
            if (!addedNames.has(nameToSet)) {
                orderedValue[nameToSet] = varValue;
                addedNames.add(nameToSet);
            }
        }

        // 3. Add constructor parameters that are not already added
        for (const v of constructor.variables) {
            if (!addedNames.has(v.name)) {
                let val = (value as Record<string, unknown>)[v.name];

                if (val === undefined) {
                    val = variables.get(v.name);
                }

                // Fallback for result parameters like ~0 or ~(n+1)
                if (val === undefined && type.name === 'Unary' && v.name === 'n') {
                    // Try to guess 'n' for Unary result if not explicitly set
                    val = variables.get('_1') ?? variables.get('param0');
                }
                if (val !== undefined) {
                    orderedValue[v.name] = val;
                    addedNames.add(v.name);
                }
            }
        }

        // 4. Add any remaining keys from 'value' (fallbacks)
        for (const key of Object.keys(value)) {
            if (!addedNames.has(key)) {
                orderedValue[key] = (value as Record<string, unknown>)[key];
            }
        }

        // Special case for ExprType mapping if needed
        if (kind === 'ExprType' && typeof orderedValue['x'] === 'number') {
            orderedValue['x'] = BigInt(orderedValue['x']);
        }

        if (constructor.resultParameters) {
            const resultArgs = constructor.resultParameters.map((expr) => {
                try {
                    return evaluator.evaluate(expr);
                } catch {
                    return undefined;
                }
            });
            this.resultArgs.set(orderedValue, resultArgs);
            for (let i = 0; i < resultArgs.length; i++) {
                const fieldNames = constructor.fields.map((field) => field.name);
                if (!fieldNames.includes(`_res${i}`)) delete orderedValue[`_res${i}`];
                if (!fieldNames.includes(`param${i}`)) delete orderedValue[`param${i}`];
            }
        }

        for (const param of constructor.parameters) {
            if (param.variable.type === 'Type') delete orderedValue[param.variable.name];
        }

        return {
            success: true,
            value: orderedValue as T,
        };
    }

    /**
     * Serialize an inline cell structure from a field declaration string
     * Example: "q:#" or "a:(## 32) ^[ e:# ] ^[ b:(## 32) d:# ^[ c:(## 32) ] ]"
     */
    private serializeInlineCell(
        fieldsStr: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: any,
        builder: Builder,
        variables: Map<string, number | bigint>,
    ): Result<void> {
        // Parse fields from the string, handling nested inline cell references
        let remaining = fieldsStr.trim();

        while (remaining.length > 0) {
            // First, check for inline cell reference: fieldName:^[ ... ]
            const inlineRefMatch = remaining.match(/^(\w+):\^\[/);
            if (inlineRefMatch) {
                const fieldName = inlineRefMatch[1];
                // Find the matching closing bracket, handling nested brackets
                let bracketCount = 0;
                let i = inlineRefMatch[0].length;
                let found = false;
                for (; i < remaining.length; i++) {
                    if (remaining[i] === '[') bracketCount++;
                    else if (remaining[i] === ']') {
                        if (bracketCount === 0) {
                            found = true;
                            break;
                        }
                        bracketCount--;
                    }
                }

                if (!found) {
                    return {
                        success: false,
                        error: new TLBDataError(`Unmatched brackets in inline cell reference for field ${fieldName}`),
                    };
                }

                // Extract the content inside ^[ ... ]
                const inlineFieldsStr = remaining.substring(inlineRefMatch[0].length, i);
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    // Create a nested builder for the inline cell reference
                    const refBuilder = beginCell();
                    const serializeResult = this.serializeInlineCell(
                        inlineFieldsStr,
                        fieldValue,
                        refBuilder,
                        variables,
                    );
                    if (!serializeResult.success) {
                        return serializeResult;
                    }
                    builder.storeRef(refBuilder.endCell());
                }

                // Move past this inline cell reference
                remaining = remaining.substring(i + 1).trim();
                continue;
            }

            // Handle # (32-bit nat)
            const hashFieldMatch = remaining.match(/^(\w+):#/);
            if (hashFieldMatch) {
                const fieldName = hashFieldMatch[1];
                const fieldValue = data[fieldName];
                if (fieldValue !== undefined) {
                    builder.storeUint(fieldValue, 32);
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                }
                remaining = remaining.substring(hashFieldMatch[0].length).trim();
                continue;
            }

            // Handle (## n) - n-bit nat
            const limitNatMatch = remaining.match(/^(\w+):\(##\s*(\w+)\)/);
            if (limitNatMatch) {
                const fieldName = limitNatMatch[1];
                const bitsExpr = limitNatMatch[2];
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    let bits: number;
                    if (/^\d+$/.test(bitsExpr)) {
                        bits = parseInt(bitsExpr, 10);
                    } else {
                        const bitsValue = variables.get(bitsExpr);
                        if (bitsValue === undefined) {
                            return {
                                success: false,
                                error: new TLBDataError(`Variable ${bitsExpr} not found for field ${fieldName}`),
                            };
                        }
                        bits = safeExpressionNumber(bitsValue);
                    }

                    builder.storeUint(fieldValue, bits);
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                }
                remaining = remaining.substring(limitNatMatch[0].length).trim();
                continue;
            }

            // If no match, try to skip whitespace or break
            const trimmed = remaining.trim();
            if (trimmed === remaining) {
                // No progress, break to avoid infinite loop
                break;
            }
            remaining = trimmed;
        }

        return {
            success: true,
            value: undefined,
        };
    }

    /**
     * Deserialize an inline cell structure from a field declaration string
     * Example: "q:#" or "a:(## 32) ^[ e:# ] ^[ b:(## 32) d:# ^[ c:(## 32) ] ]"
     */
    private deserializeInlineCell(
        fieldsStr: string,
        slice: Slice,
        variables: Map<string, number | bigint>,

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Result<any> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const value: any = {};

        // Parse fields from the string, handling nested inline cell references
        // Need to properly handle nested brackets
        let remaining = fieldsStr.trim();

        while (remaining.length > 0) {
            // First, check for inline cell reference: fieldName:^[ ... ]
            // Need to match nested brackets properly
            const inlineRefMatch = remaining.match(/^(\w+):\^\[/);
            if (inlineRefMatch) {
                const fieldName = inlineRefMatch[1];
                // Find the matching closing bracket, handling nested brackets
                let bracketCount = 0;
                let i = inlineRefMatch[0].length;
                let found = false;
                for (; i < remaining.length; i++) {
                    if (remaining[i] === '[') bracketCount++;
                    else if (remaining[i] === ']') {
                        if (bracketCount === 0) {
                            found = true;
                            break;
                        }
                        bracketCount--;
                    }
                }

                if (!found) {
                    return {
                        success: false,
                        error: new TLBDataError(`Unmatched brackets in inline cell reference for field ${fieldName}`),
                    };
                }

                // Extract the content inside ^[ ... ]
                const inlineFieldsStr = remaining.substring(inlineRefMatch[0].length, i);

                if (slice.remainingRefs === 0) {
                    return {
                        success: false,
                        error: new TLBDataError(`No more references available for inline cell field ${fieldName}`),
                    };
                }

                const ref = slice.loadRef();
                const refSlice = ref.beginParse(true);
                const inlineResult = this.deserializeInlineCell(inlineFieldsStr, refSlice, variables);
                if (inlineResult.success) {
                    value[fieldName] = inlineResult.value;
                } else {
                    return inlineResult;
                }

                // Move past this inline cell reference
                remaining = remaining.substring(i + 1).trim();
                continue;
            }

            // Parse regular field: fieldName:Type
            // Handle # (32-bit nat)
            const hashFieldMatch = remaining.match(/^(\w+):#/);
            if (hashFieldMatch) {
                const fieldName = hashFieldMatch[1];
                if (slice.remainingBits < 32) {
                    return {
                        success: false,
                        error: new TLBDataError(`Not enough bits to read field ${fieldName}`),
                    };
                }
                value[fieldName] = Number(slice.loadUint(32));
                variables.set(fieldName, value[fieldName]);
                remaining = remaining.substring(hashFieldMatch[0].length).trim();
                continue;
            }

            // Handle (## n) - n-bit nat
            const limitNatMatch = remaining.match(/^(\w+):\(##\s*(\w+)\)/);
            if (limitNatMatch) {
                const fieldName = limitNatMatch[1];
                const bitsExpr = limitNatMatch[2];
                let bits: number;
                if (/^\d+$/.test(bitsExpr)) {
                    bits = parseInt(bitsExpr, 10);
                } else {
                    const bitsValue = variables.get(bitsExpr);
                    if (bitsValue === undefined) {
                        return {
                            success: false,
                            error: new TLBDataError(`Variable ${bitsExpr} not found for field ${fieldName}`),
                        };
                    }
                    bits = safeExpressionNumber(bitsValue);
                }

                if (slice.remainingBits < bits) {
                    return {
                        success: false,
                        error: new TLBDataError(`Not enough bits to read field ${fieldName} (need ${bits} bits)`),
                    };
                }
                value[fieldName] = Number(slice.loadUint(bits));
                variables.set(fieldName, value[fieldName]);
                remaining = remaining.substring(limitNatMatch[0].length).trim();
                continue;
            }

            // If no match, try to skip whitespace or break
            const trimmed = remaining.trim();
            if (trimmed === remaining) {
                // No progress, break to avoid infinite loop
                break;
            }
            remaining = trimmed;
        }

        return {
            success: true,
            value: value,
        };
    }

    private *deserializeField(
        field: TLBField,
        slice: Slice,
        variables: Map<string, number | bigint>,
        ctxConstructor: TLBConstructor,
        ctxArgs: TLBFieldType[],
        context?: ParameterContext,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): DecodeFrame<T, any> {
        const value = yield* this.deserializeFieldType(
            field.fieldType,
            slice,
            variables,
            ctxConstructor,
            ctxArgs,
            context,
        );

        if (
            field.name &&
            (field.fieldType.kind === 'TLBNumberType' ||
                field.fieldType.kind === 'TLBVarIntegerType' ||
                field.fieldType.kind === 'TLBBoolType')
        ) {
            const numericValue = typeof value === 'bigint' ? value : Number(value);
            variables.set(field.name, numericValue);

            // Update positional alias if possible
            const vIdx = ctxConstructor.variables.findIndex((v) => v.name === field.name);
            if (vIdx !== -1) {
                variables.set(`_${vIdx + 1}`, numericValue);
            }
        }

        // Try to propagate parameter values from nested typed values if present (e.g., x: (Unary ~n) gives n)
        if (!ctxConstructor.resultParameters && value && typeof value === 'object') {
            for (const param of ctxConstructor.parameters) {
                if (
                    param.variable?.type === '#' &&
                    !param.variable.negated &&
                    variables.get(param.variable.name) === undefined
                ) {
                    const extracted = this.extractNumericProperty(value, param.variable.name);
                    if (typeof extracted === 'number') {
                        const val = extracted;
                        variables.set(param.variable.name, val);

                        // Update positional alias if possible
                        const vIdx = ctxConstructor.variables.findIndex((v) => v.name === param.variable.name);
                        if (vIdx !== -1) {
                            variables.set(`_${vIdx + 1}`, val);
                        }
                    }
                }
            }
        }

        return value;
    }

    private extractNumericProperty(value: unknown, name: string): number | undefined {
        if (!value || typeof value !== 'object') return undefined;
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null && !Array.isArray(value)) return undefined;
        const record = value as Record<string, unknown>;
        if (typeof record[name] === 'number') return record[name];
        for (const child of Object.values(record)) {
            const found = this.extractNumericProperty(child, name);
            if (found !== undefined) return found;
        }
        return undefined;
    }

    private *readDictionary(
        slice: Slice,
        keySize: number,
        valueType: TLBFieldType,
        direct: boolean,
        variables: Map<string, number | bigint>,
        ctxConstructor: TLBConstructor,
        ctxArgs: TLBFieldType[],
        context?: ParameterContext,
    ) {
        const captured = new Map(variables);
        const leafType = context ? this.bindTypeParameters(valueType, context.getAllTypeParams()) : valueType;
        const readLeaf = (leaf: Slice) =>
            this.deserializeFieldType(leafType, leaf, new Map(captured), ctxConstructor, ctxArgs, context);
        const codec = {
            parse: (leaf: Slice) => this.runDecode(readLeaf(leaf)),
            serialize: (entry: DecodedCell, leaf: Builder) =>
                this.serializeFieldType(leafType, entry, leaf, new Map(captured)),
        };
        const key: DictionaryKey<number | bigint> =
            keySize > 32 ? Dictionary.Keys.BigUint(keySize) : Dictionary.Keys.Uint(keySize);
        const raw = {
            parse: (leaf: Slice) => leaf,
            serialize: (leaf: Slice, builder: Builder) => {
                builder.storeSlice(leaf);
            },
        };
        const leaves = direct ? slice.loadDictDirect(key, raw) : slice.loadDict(key, raw);
        const values = Dictionary.empty(key, codec);
        for (const [id, leaf] of leaves) values.set(id, yield* readLeaf(leaf));
        return values;
    }

    private *deserializeFieldType(
        fieldType: TLBFieldType,
        slice: Slice,
        variables: Map<string, number | bigint>,
        ctxConstructor: TLBConstructor,
        ctxArgs: TLBFieldType[],
        context?: ParameterContext,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): DecodeFrame<T, any> {
        // Merge context parameters into variables for evaluation
        if (context) {
            const allNatParams = context.getAllNatParams();
            for (const [name, value] of allNatParams) {
                if (!variables.has(name)) {
                    variables.set(name, value);
                }
            }
        }

        const evaluator = new MathExprEvaluator(variables);

        switch (fieldType.kind) {
            case 'TLBNumberType': {
                let bits: number;
                try {
                    bits = evaluator.evaluate(fieldType.bits);
                } catch (e) {
                    // Try to infer implicit parameter from remaining bits if field.bits is a variable reference
                    if (fieldType.bits.kind === 'TLBVarExpr') {
                        const varName = fieldType.bits.x;
                        // Check if variable is already set (e.g., from type arguments)
                        const existingValue = variables.get(varName);
                        if (typeof existingValue === 'number') {
                            // Variable already set, use it
                            bits = existingValue;
                        } else {
                            // Check if this variable is an implicit parameter
                            const implicitParam = ctxConstructor?.parameters.find(
                                (p) => p.variable?.name === varName && p.variable.type === '#',
                            );
                            if (implicitParam && slice.remainingBits > 0) {
                                // Infer parameter value from remaining bits
                                const inferredValue = slice.remainingBits;
                                variables.set(varName, inferredValue);
                                bits = inferredValue;
                            } else {
                                // Try to bind all numeric parameters from ctxArgs using ctxConstructor parameter list
                                let rebound = false;
                                if (ctxConstructor?.parameters?.length && ctxArgs?.length) {
                                    for (
                                        let i = 0;
                                        i < Math.min(ctxConstructor.parameters.length, ctxArgs.length);
                                        i++
                                    ) {
                                        const p = ctxConstructor.parameters[i];
                                        const a = ctxArgs[i];
                                        if (p.variable?.type === '#') {
                                            try {
                                                let val: number | undefined;
                                                if (a.kind === 'TLBExprMathType') {
                                                    val = new MathExprEvaluator(variables).evaluate(a.initialExpr);
                                                } else if (a.kind === 'TLBNumberType') {
                                                    val = new MathExprEvaluator(variables).evaluate(a.bits);
                                                }
                                                if (typeof val === 'number') {
                                                    variables.set(p.variable.name, val);
                                                    rebound = true;
                                                }
                                            } catch {
                                                /* skip */
                                            }
                                        }
                                    }
                                    if (rebound) {
                                        bits = new MathExprEvaluator(variables).evaluate(fieldType.bits);
                                    } else {
                                        throw e;
                                    }
                                } else {
                                    throw e;
                                }
                            }
                        }
                    } else {
                        // Try to bind all numeric parameters from ctxArgs using ctxConstructor parameter list
                        let rebound = false;
                        if (ctxConstructor?.parameters?.length && ctxArgs?.length) {
                            for (let i = 0; i < Math.min(ctxConstructor.parameters.length, ctxArgs.length); i++) {
                                const p = ctxConstructor.parameters[i];
                                const a = ctxArgs[i];
                                if (p.variable?.type === '#') {
                                    try {
                                        let val: number | undefined;
                                        if (a.kind === 'TLBExprMathType') {
                                            val = new MathExprEvaluator(variables).evaluate(a.initialExpr);
                                        } else if (a.kind === 'TLBNumberType') {
                                            val = new MathExprEvaluator(variables).evaluate(a.bits);
                                        }
                                        if (typeof val === 'number') {
                                            variables.set(p.variable.name, val);
                                            rebound = true;
                                        }
                                    } catch {
                                        /* skip */
                                    }
                                }
                            }
                            if (rebound) {
                                bits = new MathExprEvaluator(variables).evaluate(fieldType.bits);
                            } else {
                                throw e;
                            }
                        } else {
                            throw e;
                        }
                    }
                }
                const val = this.loadBigInt(slice, bits, fieldType.signed);
                if (fieldType.upperBound) checkNatUpperBound(val, evaluator.evaluate(fieldType.upperBound));
                const maxBits = (fieldType as unknown as { maxBits?: number }).maxBits;
                const preferNumber = maxBits !== undefined ? maxBits <= 32 : false;
                if (!preferNumber && bits > 32) {
                    return val;
                }
                if (preferNumber || bits <= 32) {
                    return Number(val);
                }
                return val;
            }

            case 'TLBBoolType': {
                if (fieldType.value !== undefined) {
                    return fieldType.value;
                }
                return slice.loadBit();
            }

            case 'TLBBitsType': {
                const bits = evaluator.evaluate(fieldType.bits);
                return decodeBits(slice.loadBits(bits), this.config.autoText);
            }

            case 'TLBNamedType': {
                const parameter = ctxConstructor.parametersMap.get(fieldType.name);
                const argument =
                    context?.resolveType(fieldType.name) ??
                    (parameter?.variable.type === 'Type'
                        ? ctxArgs[ctxConstructor.parameters.indexOf(parameter)]
                        : undefined);
                // A concrete argument can have the same name as the formal parameter.
                if (argument?.kind === 'TLBNamedType' && argument.name === fieldType.name) {
                    fieldType = argument;
                } else if (argument) {
                    return yield* this.deserializeFieldType(
                        argument,
                        slice,
                        variables,
                        ctxConstructor,
                        ctxArgs,
                        context,
                    );
                }
                if (fieldType.name === 'Bool') {
                    // Bool type has two constructors: bool_false$0 and bool_true$1
                    // Read the tag bit (0 for false, 1 for true)
                    const bit = slice.loadBit();
                    return bit === true;
                }

                // Handle MsgAddress types: MsgAddress, MsgAddressInt, MsgAddressExt
                if (
                    fieldType.name === 'MsgAddress' ||
                    fieldType.name === 'MsgAddressInt' ||
                    fieldType.name === 'MsgAddressExt'
                ) {
                    return readAddress(slice, fieldType.name);
                }

                if (fieldType.name === 'Any') {
                    return loadRemainingCell(slice);
                }

                // Handle HashmapE type: hme_empty$0 (empty dict) or hme_root$1 (load Hashmap from ref)
                if (fieldType.name === 'HashmapE') {
                    const args = fieldType.arguments ?? [];
                    if (args.length < 2) {
                        throw new TLBDataError('HashmapE requires two arguments: key size (n) and value type (X)');
                    }

                    // Extract key size (n) from first argument
                    const keySizeArg = args[0];
                    let keySize: number;
                    if (keySizeArg.kind === 'TLBExprMathType') {
                        keySize = evaluator.evaluate(keySizeArg.initialExpr);
                    } else if (keySizeArg.kind === 'TLBNumberType') {
                        keySize = evaluator.evaluate(keySizeArg.bits);
                    } else if (keySizeArg.kind === 'TLBNamedType' && keySizeArg.name) {
                        // Argument is a parameter reference (e.g., n)
                        const varValue = variables.get(keySizeArg.name);
                        if (varValue === undefined) {
                            throw new TLBDataError(
                                `Variable ${keySizeArg.name} not found for HashmapE key size argument`,
                            );
                        }
                        keySize = safeExpressionNumber(varValue);
                    } else {
                        throw new TLBDataError(
                            'HashmapE first argument must be a numeric expression or parameter reference',
                        );
                    }

                    return yield* this.readDictionary(
                        slice,
                        keySize,
                        args[1],
                        false,
                        variables,
                        ctxConstructor,
                        ctxArgs,
                        context,
                    );
                }

                // Handle #< n and #<= n limited nat types
                if (fieldType.name === '#<' || fieldType.name === '#<=') {
                    // Evaluate the argument (n) from type arguments
                    const args = fieldType.arguments ?? [];
                    if (args.length === 0) {
                        throw new TLBDataError(`${fieldType.name} requires an argument`);
                    }
                    const arg = args[0];
                    let n: number;
                    if (arg.kind === 'TLBExprMathType') {
                        n = evaluator.evaluate(arg.initialExpr);
                    } else if (arg.kind === 'TLBNumberType') {
                        n = evaluator.evaluate(arg.bits);
                    } else if (arg.kind === 'TLBNamedType' && arg.name) {
                        // Argument is a parameter reference (e.g., n)
                        const varValue = variables.get(arg.name);
                        if (varValue === undefined) {
                            throw new TLBDataError(`Variable ${arg.name} not found for ${fieldType.name} argument`);
                        }
                        n = safeExpressionNumber(varValue);
                    } else {
                        throw new TLBDataError(`Invalid argument type for ${fieldType.name}`);
                    }

                    // Calculate bit width
                    let bits: number;
                    if (fieldType.name === '#<') {
                        bits = MathExprEvaluator.calculateBitsForLessThan(n);
                    } else {
                        bits = MathExprEvaluator.calculateBitsForLessThanOrEqual(n);
                    }

                    // Deserialize that many bits as unsigned integer
                    if (slice.remainingBits < bits) {
                        throw new TLBDataError(`Not enough bits to read ${fieldType.name} (need ${bits} bits)`);
                    }
                    const value = slice.loadUint(bits);
                    checkNatUpperBound(value, fieldType.name === '#<' ? n - 1 : n);
                    return value;
                }

                // Handle uintN, intN, bitsN types before looking up in schema
                const uintMatch = fieldType.name.match(/^uint(\d+)$/);
                if (uintMatch) {
                    const bits = parseInt(uintMatch[1], 10);
                    if (slice.remainingBits < bits) {
                        throw new TLBDataError(`Not enough bits to read uint${bits} (need ${bits} bits)`);
                    }
                    return Number(slice.loadUint(bits));
                }
                const intMatch = fieldType.name.match(/^int(\d+)$/);
                if (intMatch) {
                    const bits = parseInt(intMatch[1], 10);
                    if (slice.remainingBits < bits) {
                        throw new TLBDataError(`Not enough bits to read int${bits} (need ${bits} bits)`);
                    }
                    return Number(slice.loadInt(bits));
                }
                const bitsMatch = fieldType.name.match(/^bits(\d+)$/);
                if (bitsMatch) {
                    const bits = parseInt(bitsMatch[1], 10);
                    if (slice.remainingBits < bits) {
                        throw new TLBDataError(`Not enough bits to read bits${bits} (need ${bits} bits)`);
                    }
                    return slice.loadBits(bits);
                }

                const type = this.typeMap.get(fieldType.name);
                if (!type) {
                    throw new TLBDataError(`Type ${fieldType.name} not found in TL-B schema`);
                }
                // A variable-width integer is a type argument. Resolve its width in the caller's scope.
                // Keep explicit TLBNegatedType placeholders aligned with result parameters.
                const forwardedArgs: TLBFieldType[] = (fieldType.arguments ?? [])
                    .filter(
                        (arg) => arg.kind !== 'TLBNamedType' || !ctxConstructor?.variablesMap.get(arg.name)?.negated,
                    )
                    .map((arg) => {
                        // First check if this is a Type parameter in context
                        if (arg.kind === 'TLBNamedType' && context) {
                            const resolvedType = context.resolveType(arg.name);
                            if (resolvedType) {
                                return resolvedType;
                            }
                        }

                        // Check if argument is a type parameter reference in ctxConstructor
                        if (arg.kind === 'TLBNamedType' && ctxConstructor) {
                            const param = ctxConstructor.parametersMap.get(arg.name);
                            if (param && param.variable.type === 'Type') {
                                // This is a type parameter - find the actual type from ctxArgs
                                const paramIndex = ctxConstructor.parameters.findIndex(
                                    (p) => p.variable.name === param.variable.name,
                                );
                                if (paramIndex >= 0 && ctxArgs[paramIndex]) {
                                    return ctxArgs[paramIndex];
                                }
                            }
                        }

                        // Check if argument is a Nat parameter reference (e.g., 'n' in 'HashmapE n uint5')
                        if (arg.kind === 'TLBNamedType' && context) {
                            const natValue = context.resolveNat(arg.name);
                            if (typeof natValue === 'number') {
                                // Convert Nat parameter to TLBNumberType
                                return {
                                    kind: 'TLBNumberType' as const,
                                    bits: { kind: 'TLBNumberExpr' as const, n: natValue },
                                    signed: false,
                                } as TLBFieldType;
                            }
                        }

                        // Also check if argument references a locally computed variable (e.g., 'm' computed from constraint)
                        if (arg.kind === 'TLBNamedType' && variables.has(arg.name)) {
                            const natValue = variables.get(arg.name);
                            if (typeof natValue === 'number') {
                                // Convert Nat parameter to TLBNumberType
                                return {
                                    kind: 'TLBNumberType' as const,
                                    bits: { kind: 'TLBNumberExpr' as const, n: natValue },
                                    signed: false,
                                } as TLBFieldType;
                            }
                        }

                        return arg;
                    })
                    .map((arg) =>
                        bindNumericArgument(
                            this.bindTypeParameters(arg, context?.getAllTypeParams() ?? new Map(), variables),
                            evaluator,
                        ),
                    );
                const childVars = new Map<string, number | bigint>();
                const parentEvaluator = new MathExprEvaluator(variables);
                // Track which parameters are negated (need to propagate computed values back)
                // Map from nested parameter name to parent variable name
                const negatedParams = new Map<string, string>();
                if (type.constructors.length > 0 && forwardedArgs.length > 0) {
                    const nestedCtor = type.constructors[0];
                    const max = Math.min(forwardedArgs.length, nestedCtor.parameters.length);
                    for (let i = 0; i < max; i++) {
                        const param = nestedCtor.parameters[i];
                        const arg = forwardedArgs[i];
                        if (param.variable?.type === '#') {
                            // Check if this parameter is negated (needs value propagation from nested type)
                            if (param.variable.negated && ctxConstructor) {
                                // Find the corresponding parameter in the parent constructor by name
                                const parentParam = ctxConstructor.parameters.find(
                                    (p) => p.variable?.name === param.variable.name && p.variable.type === '#',
                                );
                                if (parentParam && parentParam.variable.negated) {
                                    // This is a negated parameter - we'll propagate the computed value back
                                    negatedParams.set(param.variable.name, param.variable.name);
                                }
                            }
                            try {
                                let val: number | undefined;
                                if (arg.kind === 'TLBExprMathType') {
                                    val = parentEvaluator.evaluate(arg.initialExpr);
                                } else if (arg.kind === 'TLBNumberType') {
                                    val = parentEvaluator.evaluate(arg.bits);
                                } else if (arg.kind === 'TLBNamedType') {
                                    const argName = arg.name;
                                    // Type argument is a parameter reference (e.g., ~n)
                                    // Check if parent constructor has a parameter with this name (for value propagation)
                                    const parentParam = ctxConstructor?.parameters.find(
                                        (p) => p.variable?.name === argName && p.variable.type === '#',
                                    );
                                    if (parentParam) {
                                        // This is a type argument that references a parent parameter
                                        // Mark it for value propagation from nested type's result
                                        // For Unary ~n, we'll extract n from the child's result
                                        negatedParams.set(param.variable.name, argName);
                                    } else {
                                        // Try to get value from parent variables
                                        const varValue = variables.get(argName);
                                        if (typeof varValue === 'number') {
                                            val = varValue;
                                        }
                                    }
                                }
                                if (typeof val === 'number') {
                                    childVars.set(param.variable.name, val);
                                }
                            } catch (error) {
                                void error;
                            }
                        }
                    }
                }

                // Forwarded arguments are evaluated in the caller. Only callee bindings belong in this scope.
                const nestedContext = new ParameterContext();

                // Add parameters from constructor to nested context
                // For parametric types like Hashmap n X, the type arguments (n, X) map to
                // constructor implicit parameters {n:#} {X:Type} stored in the variables array
                if (type.constructors.length > 0) {
                    const nestedCtor = type.constructors[0];

                    // Collect all type parameters from constructor variables (implicit parameters like {n:#} {X:Type})
                    // These should be matched with the type arguments passed to this type
                    const implicitVars = nestedCtor.variables.filter((v) => !v.negated && v.isConst === false);

                    // Map forwardedArgs to constructor variables
                    for (let i = 0; i < Math.min(forwardedArgs.length, implicitVars.length); i++) {
                        const varDef = implicitVars[i];
                        const arg = forwardedArgs[i];

                        if (varDef.type === '#' && varDef.name) {
                            // This is a Nat parameter like {n:#}
                            let natValue: number | undefined;
                            if (arg.kind === 'TLBNumberType') {
                                try {
                                    natValue = parentEvaluator.evaluate(arg.bits);
                                } catch (e) {
                                    void e;
                                }
                            } else if (arg.kind === 'TLBNamedType' && arg.name) {
                                // Could be a variable reference - try to resolve from context
                                const resolved = context?.resolveNat(arg.name);
                                if (typeof resolved === 'number') {
                                    natValue = resolved;
                                }
                            }
                            if (typeof natValue === 'number') {
                                nestedContext.setNat(varDef.name, natValue);
                            }
                        } else if (varDef.type === 'Type' && varDef.name) {
                            // This is a Type parameter like {X:Type}
                            nestedContext.setType(varDef.name, arg as TLBFieldType);
                        }
                    }
                }

                // Deserialize nested type with resolved arguments and context
                const typeResult = yield this.deserializeType(
                    type,
                    slice,
                    forwardedArgs,
                    type.isAnon
                        ? ((fieldType as ScopedField)[definingScope]?.variables ?? variables)
                        : type.constructors[0]?.resultParameters
                          ? undefined
                          : childVars,
                    type.isAnon
                        ? ((fieldType as ScopedField)[definingScope]?.context ?? context)
                        : type.constructors[0]?.resultParameters
                          ? undefined
                          : nestedContext,
                );
                if (!typeResult.success) {
                    if (typeResult.error instanceof UnsupportedAddressError) throw typeResult.error;
                    // Log useful context for debugging
                    const argsDebug = forwardedArgs
                        .map((arg) => {
                            if (arg.kind === 'TLBNumberType' && arg.bits.kind === 'TLBNumberExpr') {
                                return `${arg.bits.n}`;
                            }
                            return arg.kind;
                        })
                        .join(', ');
                    throw new TLBDataError(
                        `Failed to deserialize ${type.name} with arguments: [${argsDebug}] - ${typeResult.error?.message || 'unknown error'}`,
                    );
                }
                const nestedValue = typeResult.value;

                // Propagate computed values from nested type for negated parameters or type arguments
                // For example, x:(Unary ~n) means we need to extract n from the child's result
                if (negatedParams.size > 0 && nestedValue && typeof nestedValue === 'object') {
                    for (const [nestedParamName, parentVarName] of negatedParams.entries()) {
                        // Extract the computed value from the nested type's result
                        // For Unary type, the computed value is stored in the 'n' property
                        // Try both the nested parameter name and common result property names
                        let computedValue = this.extractNumericProperty(nestedValue, nestedParamName);
                        if (typeof computedValue !== 'number') {
                            // Also try the parent variable name (in case they're the same)
                            computedValue = this.extractNumericProperty(nestedValue, parentVarName);
                        }
                        if (typeof computedValue === 'number') {
                            variables.set(parentVarName, computedValue);
                        }
                    }
                }

                // Also check if any forwarded arguments reference parent parameters that need extraction
                // This handles cases like x:(Unary ~n) where n is a parent parameter
                if (forwardedArgs.length > 0 && nestedValue && typeof nestedValue === 'object' && ctxConstructor) {
                    for (
                        let i = 0;
                        i < Math.min(forwardedArgs.length, type.constructors[0]?.parameters.length ?? 0);
                        i++
                    ) {
                        const arg = forwardedArgs[i];
                        const param = type.constructors[0]?.parameters[i];
                        if (arg.kind === 'TLBNamedType' && param?.variable?.type === '#') {
                            const argName = arg.name;
                            // Check if parent constructor has a parameter with this name
                            const parentParam = ctxConstructor.parameters.find(
                                (p) => p.variable?.name === argName && p.variable.type === '#',
                            );
                            if (parentParam && !variables.has(argName)) {
                                // Extract the computed value from nested result
                                // For Unary, the result type value is stored as 'n'
                                const computedValue = this.extractNumericProperty(nestedValue, param.variable.name);
                                if (typeof computedValue === 'number') {
                                    variables.set(argName, computedValue);
                                }
                            }
                        }
                    }
                }

                if (nestedValue && typeof nestedValue === 'object') {
                    if (fieldType.name === 'VarUInteger' || fieldType.name === 'VarInteger') {
                        if ('value' in nestedValue) {
                            const nestedValueWithValue = nestedValue as unknown as { value: unknown };
                            // TODO maybe VarInteger 6 and VarUInteger 6 as number
                            // Always return bigint for VarUInteger/VarInteger values
                            return BigInt(nestedValueWithValue.value as number | bigint);
                        }
                    } else if (fieldType.name === 'Grams') {
                        if ('amount' in nestedValue) {
                            const nestedValueWithAmount = nestedValue as unknown as { amount: unknown };
                            return BigInt(nestedValueWithAmount.amount as number | bigint);
                        }
                    }
                }

                return nestedValue;
            }

            case 'TLBCoinsType': {
                return slice.loadCoins();
            }

            case 'TLBAddressType':
                return readAddress(slice, fieldType.name);

            case 'TLBCellType':
                return loadRemainingCell(slice);

            case 'TLBCellInsideType': {
                if (slice.remainingRefs === 0) {
                    throw new TLBDataError('No more references available for TLBCellInsideType');
                }
                const ref = slice.loadRef();
                if (fieldType.value.kind === 'TLBCellType') {
                    return ref;
                }
                const refSlice = ref.beginParse();
                return yield* this.deserializeFieldType(
                    fieldType.value,
                    refSlice,
                    variables,
                    ctxConstructor,
                    ctxArgs,
                    context,
                );
            }

            case 'TLBRefType': {
                // Cell reference: ^Type (where Type can be Cell or a user type name)
                if (slice.remainingRefs === 0) {
                    throw new TLBDataError('No more references available for TLBRefType');
                }
                const ref = slice.loadRef();

                // If inner type is TLBCellType, just return the cell
                if (fieldType.value.kind === 'TLBCellType') {
                    return ref;
                }

                // If inner type is TLBNamedType with name "Cell", return the cell
                if (fieldType.value.kind === 'TLBNamedType' && fieldType.value.name === 'Cell') {
                    return ref;
                }

                // Otherwise, deserialize the inner type from the reference
                const refSlice = ref.beginParse();
                return yield* this.deserializeFieldType(
                    fieldType.value,
                    refSlice,
                    variables,
                    ctxConstructor,
                    ctxArgs,
                    context,
                );
            }

            case 'TLBHashmapType':
                return yield* this.readDictionary(
                    slice,
                    evaluator.evaluate(fieldType.key),
                    fieldType.value,
                    fieldType.directStore === true,
                    variables,
                    ctxConstructor,
                    ctxArgs,
                    context,
                );

            case 'TLBVarIntegerType': {
                const size = evaluator.evaluate(fieldType.n);
                if (fieldType.signed) {
                    return slice.loadVarIntBig(size);
                } else {
                    if (
                        fieldType.upperBound &&
                        (size ? slice.preloadUint(size) : 0) >= evaluator.evaluate(fieldType.upperBound)
                    )
                        throw new TLBDataError('VarUInteger byte length exceeds bound');
                    return slice.loadVarUintBig(size);
                }
            }

            case 'TLBMultipleType': {
                const times = evaluator.evaluate(fieldType.times);
                const result = [];
                for (let i = 0; i < times; i++) {
                    result.push(
                        yield* this.deserializeFieldType(
                            fieldType.value,
                            slice,
                            variables,
                            ctxConstructor,
                            ctxArgs,
                            context,
                        ),
                    );
                }
                return result;
            }

            case 'TLBCondType': {
                const condition = evaluator.evaluate(fieldType.condition);
                if (condition) {
                    return yield* this.deserializeFieldType(
                        fieldType.value,
                        slice,
                        variables,
                        ctxConstructor,
                        ctxArgs,
                        context,
                    );
                }
                return undefined;
            }

            case 'TLBTupleType': {
                const items = parseTuple(slice.asCell());
                slice.skip(24);
                const top = items.at(-1);
                if (!top) return items;

                // The tail is referenced. Only the top stack item shares the enclosing slice.
                slice.loadRef();
                const tag = slice.loadUint(8);
                switch (top.type) {
                    case 'int':
                        slice.skip(tag === 1 ? 64 : 7 + 257);
                        break;
                    case 'nan':
                        slice.skip(8);
                        break;
                    case 'slice':
                        slice.skip(26);
                        slice.loadRef();
                        break;
                    case 'cell':
                    case 'builder':
                        slice.loadRef();
                        break;
                    case 'tuple':
                        slice.skip(16);
                        for (let i = 0; i < Math.min(2, top.items.length); i++) slice.loadRef();
                        break;
                }
                return items;
            }

            default:
                throw new TLBDataError(`Unsupported field type: ${fieldType.kind}`);
        }
    }

    // FIXME
    private serializeType(
        type: TLBType,
        data: any, // eslint-disable-line @typescript-eslint/no-explicit-any
        builder: Builder,
        args: TLBFieldType[] = [],
        callerVariables = new Map<string, number | bigint>(),
        enclosingTypes?: Map<string, TLBFieldType>,
    ): void {
        // Anonymous groups have one implicit constructor, including older records with a generated kind.
        const typeKind = type.isAnon ? undefined : (data as TypeCell).kind;
        let constructor: TLBConstructor | undefined;

        if (typeKind === undefined || typeKind === type.name) {
            const evaluator = new MathExprEvaluator(callerVariables);
            const candidates = type.constructors.filter((c) =>
                c.parameters.every((p, i) => {
                    const arg = args[i];
                    if (!arg || p.variable.negated || p.paramExpr?.kind !== 'TLBNumberExpr') return true;
                    const expr =
                        arg.kind === 'TLBExprMathType'
                            ? arg.initialExpr
                            : arg.kind === 'TLBNumberType'
                              ? arg.bits
                              : undefined;
                    return !expr || evaluator.evaluate(expr) === p.paramExpr.n;
                }),
            );
            if (candidates.length !== 1) {
                throw new TLBDataError(
                    `Expected an unambiguous kind for ${type.name}; candidates: ${candidates.map((c) => type.name + '_' + c.name).join(', ')}`,
                );
            }
            constructor = candidates[0];
        } else if (typeof typeKind === 'string') {
            const name = typeKind.startsWith(type.name + '_') ? typeKind.slice(type.name.length + 1) : typeKind;
            constructor = type.constructors.find((c) => c.name === name);
        }

        if (!constructor) {
            throw new UnknownKindError(`Constructor not found for type ${typeKind || type.name}`);
        }

        // Store tag if present
        const { bitLen: tagBitLen, binary: tagBinary } = constructor.tag;

        if (tagBitLen > 0) {
            const tag = BigInt(tagBinary);
            builder.storeUint(tag, tagBitLen);
        }

        // Initialize variables map for constraint evaluation and add positional aliases
        const variables = new Map<string, number | bigint>(type.isAnon ? callerVariables : undefined);

        const resultArguments: { expression: _TLBMathExpr; expected: number }[] = [];
        const typeParams = new Map<string, TLBFieldType>(type.isAnon ? enclosingTypes : undefined);
        for (const [i, param] of constructor.parameters.entries()) {
            const arg = args[i];
            if (!arg) continue;
            if (param.variable.type === 'Type') {
                typeParams.set(param.variable.name, bindNumericArgument(arg, new MathExprEvaluator(callerVariables)));
            }
            if (param.variable.type === '#' && (!param.variable.negated || constructor.resultParameters)) {
                const expression =
                    arg.kind === 'TLBExprMathType'
                        ? arg.initialExpr
                        : arg.kind === 'TLBNumberType'
                          ? arg.bits
                          : undefined;
                if (!expression) continue;
                const n = new MathExprEvaluator(callerVariables).evaluate(expression);
                if (param.argName) variables.set(param.argName, n);
                const result = param.paramExpr ?? constructor.resultParameters?.[i];
                if (result?.kind === 'TLBVarExpr') {
                    const name = result.x;
                    if (data[name] !== undefined && data[name] !== n) {
                        throw new TLBDataError(`Conflicting parameter ${name}: expected ${n}, got ${data[name]}`);
                    }
                    variables.set(name, n);
                } else if (result) {
                    resultArguments.push({ expression: result, expected: n });
                }
            }
        }

        // Extract parameter values from data object and add to variables map
        if (constructor.parameters.length > 0) {
            for (const param of constructor.parameters) {
                if (param.variable?.name && param.variable.type === '#') {
                    if (param.variable.isConst && param.variable.constValue !== undefined) {
                        variables.set(param.variable.name, param.variable.constValue);
                    } else {
                        const paramValue = data[param.variable.name];
                        if (typeof paramValue === 'number') {
                            variables.set(param.variable.name, paramValue);
                        }
                    }
                }
            }
        } else if (constructor.variables.length > 0) {
            // Fallback: use variables array if parameters array is empty
            const fieldNamesSet = new Set(constructor.fields.map((f) => f.name));
            for (const v of constructor.variables) {
                if (v.type === '#' && !v.negated && !v.isConst && !fieldNamesSet.has(v.name)) {
                    const paramValue = data[v.name];
                    if (typeof paramValue === 'number') {
                        variables.set(v.name, paramValue);
                    }
                }
            }
        }

        for (const field of constructor.fields) {
            if (!field.implicit || !field.name || constructor.variablesMap.get(field.name)?.type !== '#') continue;
            const supplied = data[field.name];
            if (supplied !== undefined && (!Number.isSafeInteger(supplied) || supplied < 0 || supplied > 0xffffffff))
                throw new TLBDataError(`Invalid natural parameter ${field.name}`);
        }
        // Add positional aliases for all variables
        for (let i = 0; i < constructor.variables.length; i++) {
            const v = constructor.variables[i];
            let val = variables.get(v.name);

            // If not found in variables map, try to get from data object
            if (val === undefined && data[v.name] !== undefined) {
                const dataVal = data[v.name];
                if (typeof dataVal === 'number') {
                    val = dataVal;
                } else if (typeof dataVal === 'bigint') {
                    val = Number(dataVal);
                } else if (typeof dataVal === 'boolean') {
                    val = dataVal ? 1 : 0;
                }
            }

            if (val !== undefined) {
                variables.set(v.name, val); // Ensure it's in variables map for name-based lookup
                variables.set(`_${i + 1}`, val); // Add positional alias
            }
        }

        // Bind compound result arguments after collecting explicit fields and simple parameters.
        const evaluator = new MathExprEvaluator(variables);
        this.bindResultArguments(resultArguments, variables, type.name);

        let anonymousIndex = 0;
        const writeFields = (fields: TLBField[], target: Builder) => {
            for (const field of fields) {
                // The decoder assigns a slot to each top-level anonymous field, including reference groups.
                // Within a flattened reference group only its unnamed leaves receive slots.
                const name =
                    field.name ||
                    (fields === constructor.fields || !field.subFields.length ? `anon${anonymousIndex++}` : '');
                if (field.implicit) continue;
                if (field.subFields.length) {
                    const nested = beginCell();
                    writeFields(field.subFields, nested);
                    target.storeRef(nested.endCell());
                    continue;
                }
                let fieldType = this.bindTypeParameters(field.fieldType, typeParams, variables);
                while (
                    fieldType.kind === 'TLBCondType' &&
                    new MathExprEvaluator(variables).evaluate(fieldType.condition)
                ) {
                    fieldType = fieldType.value;
                }
                if (fieldType.kind === 'TLBCondType') continue;
                let fieldValue = data[name];
                if (
                    fieldValue === undefined &&
                    field.name &&
                    (Object.hasOwn(data, '_' + name) || Object.hasOwn(data, name + '0'))
                ) {
                    const alias = legacyFieldName(name);
                    if (alias && !constructor.fields.some((f) => f.name === alias)) fieldValue = data[alias];
                }
                if (
                    fieldValue === undefined &&
                    !field.name &&
                    data.anon0 !== undefined &&
                    canUseLegacyAnon0(field, constructor.fields)
                ) {
                    fieldValue = data.anon0;
                }
                if (fieldValue === undefined) throw new TLBDataError(`Missing required field ${name} in ${type.name}`);
                this.serializeField({ ...field, fieldType }, fieldValue, target, variables, typeParams);
                this.solveConstraints(constructor.constraints, variables);
            }
        };
        this.solveConstraints(constructor.constraints, variables);
        writeFields(constructor.fields, builder);

        // Handle case where codegen doesn't generate fields but declaration has them
        // Example: "_ x:# = OneNatParam;" where x is a field but not generated by codegen
        if (this.compileSchema !== compileLegacySchema && constructor.fields.length === 0 && constructor.declaration) {
            // Parse declaration to extract field information
            // Format: "_ x:# = OneNatParam;" -> extract "x:#"
            // Also handle multiple fields: "_ x:# y:# = TwoNatParam;"
            // Also handle cell references: "_ x:^Cell = ParamCell;" or "_ x:^ParamCell = UseParamCell;"
            // Also handle ## n types: "_ x:(## 5) = LimitNat;" or "_ {n:#} x:(## n) = ParamType n;"
            // Also handle parameterized types: "_ x:(ParamType 4) = UseParamType;"
            // Also handle anonymous fields: "_ (## 1) = AnonymousData;" -> anon0, anon1, etc.

            let anonFieldIndex = 0; // Track anonymous field index

            // First, handle anonymous fields (fields without names) - must come before named field patterns
            // Pattern: (## n) without field name prefix
            // Example: "_ (## 1) = AnonymousData;"

            // Handle anonymous ## n types: (## 1) or (## n)
            const declaration = constructor.declaration.replace(/\{[^}]*\}/g, '');
            const anonLimitNatMatches = Array.from(declaration.matchAll(/\(##\s*(\w+)\)/g));
            for (const match of anonLimitNatMatches) {
                // Skip if this is part of a named field (e.g., "x:(## 1)" - already handled by named patterns)
                const matchIndex = match.index!;
                const beforeMatch = declaration.substring(0, matchIndex);
                // Check if there's a field name before this match (word followed by colon)
                const beforeTrimmed = beforeMatch.trim();
                if (beforeTrimmed.endsWith(':') || /:\s*$/.test(beforeTrimmed)) {
                    // This is part of a named field, skip it (will be handled by named field patterns)
                    continue;
                }

                const bitsExpr = match[1];
                const fieldName = `anon${anonFieldIndex++}`;
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    // Evaluate bits expression (could be constant number or variable name)
                    let bits: number;
                    if (/^\d+$/.test(bitsExpr)) {
                        // Constant: (## 1)
                        bits = parseInt(bitsExpr, 10);
                    } else {
                        // Variable: (## n) - get from variables map
                        const bitsValue = variables.get(bitsExpr);
                        if (bitsValue === undefined) {
                            throw new TLBDataError(`Variable ${bitsExpr} not found for anonymous field`);
                        }
                        bits = safeExpressionNumber(bitsValue);
                    }

                    // Serialize as n-bit number
                    builder.storeUint(fieldValue, bits);
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                }
            }

            // First, handle numeric fields (#) - 32-bit nat
            const fieldMatches = declaration.matchAll(/(\w+):#/g);
            for (const match of fieldMatches) {
                const fieldName = match[1];
                const fieldValue = data[fieldName];
                if (fieldValue !== undefined) {
                    // Serialize as 32-bit number (type #)
                    builder.storeUint(fieldValue, 32);
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                }
            }

            // Handle ## n types: (## 5) with constant, or (## n) with variable
            const limitNatMatches = declaration.matchAll(/(\w+):\(##\s*(\w+)\)/g);
            for (const match of limitNatMatches) {
                const fieldName = match[1];
                const bitsExpr = match[2];
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    // Evaluate bits expression (could be constant number or variable name)
                    let bits: number;
                    if (/^\d+$/.test(bitsExpr)) {
                        // Constant: (## 5)
                        bits = parseInt(bitsExpr, 10);
                    } else {
                        // Variable: (## n) - get from variables map
                        const bitsValue = variables.get(bitsExpr);
                        if (bitsValue === undefined) {
                            throw new TLBDataError(`Variable ${bitsExpr} not found for field ${fieldName}`);
                        }
                        bits = safeExpressionNumber(bitsValue);
                    }

                    // Serialize as n-bit number
                    builder.storeUint(fieldValue, bits);
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                }
            }

            // Handle #< n and #<= n types: x:(#< 4) or x:(#<= 4)
            const lessThanMatches = declaration.matchAll(/(\w+):\((#<|#<=)\s+(\w+)\)/g);
            for (const match of lessThanMatches) {
                const fieldName = match[1];
                const typeName = match[2]; // '#<' or '#<='
                const nExpr = match[3]; // Could be constant number or variable name
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    // Evaluate n
                    let n: number;
                    if (/^\d+$/.test(nExpr)) {
                        // Constant: (#< 4)
                        n = parseInt(nExpr, 10);
                    } else {
                        // Variable: (#< n) - get from variables map
                        const nValue = variables.get(nExpr);
                        if (nValue === undefined) {
                            throw new TLBDataError(`Variable ${nExpr} not found for field ${fieldName}`);
                        }
                        n = safeExpressionNumber(nValue);
                    }

                    // Calculate bit width
                    let bits: number;
                    if (typeName === '#<') {
                        bits = MathExprEvaluator.calculateBitsForLessThan(n);
                    } else {
                        bits = MathExprEvaluator.calculateBitsForLessThanOrEqual(n);
                    }

                    // Serialize value using that many bits
                    builder.storeUint(fieldValue, bits);
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                }
            }

            // Handle int and uint types: x:int257 or x:uint256
            // Match both: int257 and uint256
            const intConstantMatches = declaration.matchAll(/(\w+):int(\d+)/g);
            for (const match of intConstantMatches) {
                const fieldName = match[1];
                const bits = parseInt(match[2], 10);
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    // Serialize as signed integer with specified bits
                    builder.storeInt(fieldValue, bits);
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                }
            }

            const uintConstantMatches = declaration.matchAll(/(\w+):uint(\d+)/g);
            for (const match of uintConstantMatches) {
                const fieldName = match[1];
                const bits = parseInt(match[2], 10);
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    // Serialize as unsigned integer with specified bits
                    builder.storeUint(fieldValue, bits);
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                }
            }

            // Handle parameterized int types: x:(int (e * 8)) or x:(int n)
            const intExprMatches = declaration.matchAll(/(\w+):\(int\s+([^)]+)\)/g);
            for (const match of intExprMatches) {
                const fieldName = match[1];
                const bitsExpr = match[2].trim();
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    // Evaluate bits expression (could be constant number, variable name, or expression)
                    let bits: number;
                    if (/^\d+$/.test(bitsExpr)) {
                        // Constant: (int 257)
                        bits = parseInt(bitsExpr, 10);
                    } else {
                        // Try to evaluate as math expression
                        try {
                            // Parse simple expressions like "e * 8" or "n + 1"
                            if (
                                bitsExpr.includes('+') ||
                                bitsExpr.includes('-') ||
                                bitsExpr.includes('*') ||
                                bitsExpr.includes('/')
                            ) {
                                // Simple expression parsing - split by operators and evaluate
                                const parts = bitsExpr.split(/([+\-*/])/);
                                let result = 0;
                                let op = '+';
                                for (const part of parts) {
                                    const trimmed = part.trim();
                                    if (trimmed === '+' || trimmed === '-' || trimmed === '*' || trimmed === '/') {
                                        op = trimmed;
                                    } else if (/^\d+$/.test(trimmed)) {
                                        const num = parseInt(trimmed, 10);
                                        if (op === '+') result += num;
                                        else if (op === '-') result -= num;
                                        else if (op === '*') result *= num;
                                        else if (op === '/') result = Math.floor(result / num);
                                    } else {
                                        // Variable name
                                        const varValue = variables.get(trimmed);
                                        if (varValue === undefined) {
                                            throw new TLBDataError(
                                                `Variable ${trimmed} not found for field ${fieldName}`,
                                            );
                                        }
                                        if (op === '+') result += safeExpressionNumber(varValue);
                                        else if (op === '-') result -= safeExpressionNumber(varValue);
                                        else if (op === '*') result *= safeExpressionNumber(varValue);
                                        else if (op === '/')
                                            result = Math.floor(result / safeExpressionNumber(varValue));
                                    }
                                }
                                bits = result;
                            } else {
                                // Single variable name
                                const varValue = variables.get(bitsExpr);
                                if (varValue === undefined) {
                                    throw new TLBDataError(`Variable ${bitsExpr} not found for field ${fieldName}`);
                                }
                                bits = safeExpressionNumber(varValue);
                            }
                        } catch (_error) {
                            throw new TLBDataError(
                                `Failed to evaluate bits expression for field ${fieldName}: ${bitsExpr}`,
                            );
                        }
                    }

                    // Serialize as signed integer with calculated bits
                    builder.storeInt(fieldValue, bits);
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                }
            }

            // Handle parameterized uint types: x:(uint (7 * e)) or x:(uint n)
            const uintExprMatches = declaration.matchAll(/(\w+):\(uint\s+([^)]+)\)/g);
            for (const match of uintExprMatches) {
                const fieldName = match[1];
                const bitsExpr = match[2].trim();
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    // Evaluate bits expression (could be constant number, variable name, or expression)
                    let bits: number;
                    if (/^\d+$/.test(bitsExpr)) {
                        // Constant: (uint 256)
                        bits = parseInt(bitsExpr, 10);
                    } else {
                        // Try to evaluate as math expression
                        try {
                            // Parse simple expressions like "7 * e" or "n + 1"
                            if (
                                bitsExpr.includes('+') ||
                                bitsExpr.includes('-') ||
                                bitsExpr.includes('*') ||
                                bitsExpr.includes('/')
                            ) {
                                // Simple expression parsing - split by operators and evaluate
                                const parts = bitsExpr.split(/([+\-*/])/);
                                let result = 0;
                                let op = '+';
                                for (const part of parts) {
                                    const trimmed = part.trim();
                                    if (trimmed === '+' || trimmed === '-' || trimmed === '*' || trimmed === '/') {
                                        op = trimmed;
                                    } else if (/^\d+$/.test(trimmed)) {
                                        const num = parseInt(trimmed, 10);
                                        if (op === '+') result += num;
                                        else if (op === '-') result -= num;
                                        else if (op === '*') result *= num;
                                        else if (op === '/') result = Math.floor(result / num);
                                    } else {
                                        // Variable name
                                        const varValue = variables.get(trimmed);
                                        if (varValue === undefined) {
                                            throw new TLBDataError(
                                                `Variable ${trimmed} not found for field ${fieldName}`,
                                            );
                                        }
                                        if (op === '+') result += safeExpressionNumber(varValue);
                                        else if (op === '-') result -= safeExpressionNumber(varValue);
                                        else if (op === '*') result *= safeExpressionNumber(varValue);
                                        else if (op === '/')
                                            result = Math.floor(result / safeExpressionNumber(varValue));
                                    }
                                }
                                bits = result;
                            } else {
                                // Single variable name
                                const varValue = variables.get(bitsExpr);
                                if (varValue === undefined) {
                                    throw new TLBDataError(`Variable ${bitsExpr} not found for field ${fieldName}`);
                                }
                                bits = safeExpressionNumber(varValue);
                            }
                        } catch (_error) {
                            throw new TLBDataError(
                                `Failed to evaluate bits expression for field ${fieldName}: ${bitsExpr}`,
                            );
                        }
                    }

                    // Serialize as unsigned integer with calculated bits
                    builder.storeUint(fieldValue, bits);
                    variables.set(fieldName, typeof fieldValue === 'bigint' ? fieldValue : Number(fieldValue));
                }
            }

            // Handle bits types: x:bits256 or x:(bits (5 + e))
            // Match both constant: bits256 and expression: (bits (5 + e))
            const bitsConstantMatches = declaration.matchAll(/(\w+):bits(\d+)/g);
            for (const match of bitsConstantMatches) {
                const fieldName = match[1];
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    let bitString: BitString;
                    if (typeof fieldValue === 'string') {
                        bitString = stringToBits(fieldValue);
                    } else if (fieldValue instanceof BitString) {
                        bitString = fieldValue;
                    } else {
                        throw new TLBDataError(`Field ${fieldName} must be a string or BitString for bits type`);
                    }
                    builder.storeBits(bitString);
                }
            }

            // Handle bits with expression: (bits (5 + e))
            const bitsExprMatches = declaration.matchAll(/(\w+):\(bits\s+([^)]+)\)/g);
            for (const match of bitsExprMatches) {
                const fieldName = match[1];
                const bitsExpr = match[2].trim();
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    // Preserve validation of variable operands before storing the supplied bits.
                    for (const operand of bitsExpr.split(/[+\-*/]/)) {
                        const name = operand.trim();
                        if (/^\d+$/.test(name)) continue;
                        const value = variables.get(name);
                        if (value === undefined || !Number.isSafeInteger(Number(value))) {
                            throw new TLBDataError(
                                `Failed to evaluate bits expression for field ${fieldName}: ${bitsExpr}`,
                            );
                        }
                    }

                    let bitString: BitString;
                    if (typeof fieldValue === 'string') {
                        bitString = stringToBits(fieldValue);
                    } else if (fieldValue instanceof BitString) {
                        bitString = fieldValue;
                    } else {
                        throw new TLBDataError(`Field ${fieldName} must be a string or BitString for bits type`);
                    }
                    builder.storeBits(bitString);
                }
            }

            // Handle parameterized types: x:(ParamType 4) or x:(ExprType 6)
            // Pattern: fieldName:(TypeName arg1 arg2 ...)
            const paramTypeMatches = declaration.matchAll(/(\w+):\((\w+)(?:\s+([^)]+))?\)/g);
            for (const match of paramTypeMatches) {
                const fieldName = match[1];
                const typeName = match[2];
                const argsStr = match[3] || '';
                const fieldValue = data[fieldName];

                // Skip if already handled by ## n pattern above
                if (typeName === '##') continue;

                // Skip if already handled by #< or #<= pattern above
                if (typeName === '#<' || typeName === '#<=') continue;

                // Skip if already handled by bits pattern above
                if (typeName === 'bits') continue;

                if (fieldValue !== undefined) {
                    const type = this.typeMap.get(typeName);
                    if (!type) {
                        throw new TLBDataError(`Type ${typeName} not found for field ${fieldName}`);
                    }

                    // Parse type arguments (e.g., "4" from "(ParamType 4)" or "A" from "(Maybe A)" or "^OptionType" from "(HashmapE 100 ^OptionType)")
                    // Use the same parsing logic as deserializeConstructor
                    const args: TLBFieldType[] = [];
                    if (argsStr.trim()) {
                        // Split arguments by whitespace, but be careful with expressions like "(n+2)"
                        // First, handle expressions in parentheses separately
                        let remaining = argsStr.trim();
                        while (remaining.length > 0) {
                            remaining = remaining.trim();
                            if (!remaining) break;

                            // Check if it starts with a parenthesis (expression like "(n+2)")
                            if (remaining.startsWith('(')) {
                                // Find matching closing parenthesis
                                let depth = 0;
                                let i = 0;
                                for (; i < remaining.length; i++) {
                                    if (remaining[i] === '(') depth++;
                                    else if (remaining[i] === ')') {
                                        depth--;
                                        if (depth === 0) break;
                                    }
                                }
                                if (depth !== 0) {
                                    // Unmatched parentheses - treat as type name
                                    const spaceIdx = remaining.indexOf(' ');
                                    const argPart = spaceIdx >= 0 ? remaining.substring(0, spaceIdx) : remaining;
                                    args.push({
                                        kind: 'TLBNamedType',
                                        name: argPart,
                                        arguments: [],
                                    });
                                    remaining = spaceIdx >= 0 ? remaining.substring(spaceIdx + 1) : '';
                                    continue;
                                }

                                // Extract expression inside parentheses (e.g., "n+2" from "(n+2)")
                                const exprStr = remaining.substring(1, i);
                                remaining = remaining.substring(i + 1).trim();

                                // Try to parse as arithmetic expression
                                // Simple parser for expressions like "n+2", "n*2", "2+n", etc.
                                const exprMatch = exprStr.match(
                                    /^([a-z_][a-zA-Z0-9_]*|\d+)\s*([+\-*/])\s*([a-z_][a-zA-Z0-9_]*|\d+)$/,
                                );
                                if (exprMatch) {
                                    const left = exprMatch[1];
                                    const op = exprMatch[2];
                                    const right = exprMatch[3];

                                    // Convert to MathExpr structure
                                    const leftExpr: Parameters<MathExprEvaluator['evaluate']>[0] = /^\d+$/.test(left)
                                        ? { kind: 'TLBNumberExpr', n: parseInt(left, 10) }
                                        : { kind: 'TLBVarExpr', x: left };

                                    const rightExpr: Parameters<MathExprEvaluator['evaluate']>[0] = /^\d+$/.test(right)
                                        ? { kind: 'TLBNumberExpr', n: parseInt(right, 10) }
                                        : { kind: 'TLBVarExpr', x: right };

                                    // Convert to TLBExprMathType
                                    args.push({
                                        kind: 'TLBExprMathType',
                                        initialExpr: {
                                            kind: 'TLBBinaryOp',
                                            operation: op as '+' | '-' | '*' | '/',
                                            left: leftExpr,
                                            right: rightExpr,
                                        } as Parameters<MathExprEvaluator['evaluate']>[0],
                                    } as TLBFieldType);
                                } else {
                                    // Not a simple expression - might be just a parameter or number
                                    if (/^\d+$/.test(exprStr)) {
                                        const argValue = parseInt(exprStr, 10);
                                        args.push({
                                            kind: 'TLBNumberType',
                                            bits: { kind: 'TLBNumberExpr', n: argValue },
                                            signed: false,
                                        });
                                    } else {
                                        // Treat as parameter reference
                                        args.push({
                                            kind: 'TLBNamedType',
                                            name: exprStr,
                                            arguments: [],
                                        });
                                    }
                                }
                                continue;
                            }

                            // Not starting with parenthesis - split by whitespace
                            const spaceIdx = remaining.indexOf(' ');
                            const argPart = spaceIdx >= 0 ? remaining.substring(0, spaceIdx) : remaining;
                            remaining = spaceIdx >= 0 ? remaining.substring(spaceIdx + 1) : '';

                            // Check if it's a cell reference (e.g., "^OptionType")
                            if (argPart.startsWith('^')) {
                                const refTypeName = argPart.substring(1);
                                args.push({
                                    kind: 'TLBRefType',
                                    value: {
                                        kind: 'TLBNamedType',
                                        name: refTypeName,
                                        arguments: [],
                                    },
                                });
                            } else if (/^\d+$/.test(argPart)) {
                                // It's a numeric argument (e.g., "4")
                                const argValue = parseInt(argPart, 10);
                                args.push({
                                    kind: 'TLBNumberType',
                                    bits: { kind: 'TLBNumberExpr', n: argValue },
                                    signed: false,
                                });
                            } else if (/^[a-z_][a-zA-Z0-9_]*$/.test(argPart)) {
                                // It's a parameter reference or type name
                                // Check if it's in variables map, if so treat as parameter, otherwise as type name
                                if (variables.has(argPart)) {
                                    // It's a parameter - create TLBNamedType for parameter reference
                                    args.push({
                                        kind: 'TLBNamedType',
                                        name: argPart,
                                        arguments: [],
                                    });
                                } else {
                                    // It's a type name argument (e.g., "A" from "(Maybe A)")
                                    args.push({
                                        kind: 'TLBNamedType',
                                        name: argPart,
                                        arguments: [],
                                    });
                                }
                            } else {
                                // Unknown format - treat as type name
                                args.push({
                                    kind: 'TLBNamedType',
                                    name: argPart,
                                    arguments: [],
                                });
                            }
                        }
                    }

                    // Serialize the parameterized type
                    // For parameterized types like Maybe X, we need to pass the type arguments
                    // Use serializeFieldType with TLBNamedType that includes the arguments
                    const fieldType: TLBFieldType = {
                        kind: 'TLBNamedType',
                        name: typeName,
                        arguments: args,
                    };
                    this.serializeFieldType(fieldType, fieldValue, builder, variables);
                }
            }

            // Handle inline cell references: ^[ field:Type ... ]
            // Pattern: fieldName:^[ ... ] where ... contains field definitions
            // Need to handle nested brackets properly
            let declRemaining = declaration;
            while (declRemaining.length > 0) {
                const inlineRefMatch = declRemaining.match(/(\w+):\^\[/);
                if (!inlineRefMatch) {
                    break;
                }

                const fieldName = inlineRefMatch[1];
                const matchIndex = inlineRefMatch.index!;

                // Find the matching closing bracket, handling nested brackets
                let bracketCount = 0;
                let i = matchIndex + inlineRefMatch[0].length;
                let found = false;
                for (; i < declRemaining.length; i++) {
                    if (declRemaining[i] === '[') bracketCount++;
                    else if (declRemaining[i] === ']') {
                        if (bracketCount === 0) {
                            found = true;
                            break;
                        }
                        bracketCount--;
                    }
                }

                if (!found) {
                    break;
                }

                // Extract the content inside ^[ ... ]
                const inlineFieldsStr = declRemaining.substring(matchIndex + inlineRefMatch[0].length, i);
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    // Create a nested builder for the inline cell reference
                    const refBuilder = beginCell();
                    const serializeResult = this.serializeInlineCell(
                        inlineFieldsStr,
                        fieldValue,
                        refBuilder,
                        variables,
                    );
                    if (!serializeResult.success) {
                        throw serializeResult.error;
                    }
                    builder.storeRef(refBuilder.endCell());
                }

                // Move past this inline cell reference
                declRemaining = declRemaining.substring(i + 1);
            }

            // Handle simple type names: x:Bool (without parentheses)
            // Pattern: fieldName:TypeName (but not fieldName:#, fieldName:bits256, fieldName:int257, etc.)
            // Only match known type names that aren't already handled by other patterns
            const simpleTypeMatches = declaration.matchAll(/(\w+):([A-Z][a-zA-Z0-9_]*)/g);
            for (const match of simpleTypeMatches) {
                const fieldName = match[1];
                const typeName = match[2];
                const fieldValue = data[fieldName];

                // Skip if this is part of a parameterized type (e.g., "x:(ParamType 4)" - already handled)
                const beforeMatch = declaration.substring(0, match.index!);
                if (beforeMatch.endsWith('(')) {
                    continue;
                }

                // Skip if this is part of a cell reference (e.g., "x:^Cell" - already handled)
                if (beforeMatch.endsWith('^')) {
                    continue;
                }

                // Handle Bool type
                if (typeName === 'Bool') {
                    if (fieldValue !== undefined) {
                        // Write the tag bit (0 for false, 1 for true)
                        builder.storeBit(fieldValue ? 1 : 0);
                    }
                    continue;
                }

                // Handle MsgAddress types: MsgAddress, MsgAddressInt, MsgAddressExt
                if (typeName === 'MsgAddress' || typeName === 'MsgAddressInt' || typeName === 'MsgAddressExt') {
                    if (fieldValue !== undefined) writeAddress(builder, fieldValue, typeName);
                    continue;
                }

                // For other simple types, try to find the type and serialize it
                const type = this.typeMap.get(typeName);
                if (type && fieldValue !== undefined) {
                    this.serializeType(type, fieldValue, builder);
                }
            }

            // Handle cell references: ^Cell or ^TypeName
            const cellRefMatches = declaration.matchAll(/(\w+):\^(\w+)/g);
            for (const match of cellRefMatches) {
                const fieldName = match[1];
                const refTypeName = match[2];
                const fieldValue = data[fieldName];

                if (fieldValue !== undefined) {
                    if (refTypeName === 'Cell') {
                        // ^Cell - store the cell directly
                        if (fieldValue instanceof Cell) {
                            builder.storeRef(fieldValue);
                        } else {
                            throw new TLBDataError(`Field ${fieldName} must be a Cell instance for ^Cell type`);
                        }
                    } else {
                        // ^TypeName - serialize the type to a nested cell
                        const type = this.typeMap.get(refTypeName);
                        if (type) {
                            const nestedBuilder = beginCell();
                            this.serializeType(type, fieldValue, nestedBuilder);
                            builder.storeRef(nestedBuilder.endCell());
                        } else {
                            throw new TLBDataError(`Type ${refTypeName} not found for field ${fieldName}`);
                        }
                    }
                }
            }
        }

        // Check constraints
        this.solveConstraints(constructor.constraints, variables);
        for (const constraint of constructor.constraints) {
            if (evaluator.evaluate(constraint) !== 1) {
                throw new TLBDataError(`Constraint failed for type ${type.name}, constructor ${constructor.name}`);
            }
        }
        for (const [i, arg] of args.entries()) {
            const result = constructor.resultParameters?.[i];
            if (arg.kind === 'TLBNegatedType' && result) {
                const value = evaluator.evaluate(result);
                const previous = callerVariables.get(arg.variableName);
                if (previous !== undefined && BigInt(previous) !== BigInt(value))
                    throw new TLBDataError(`Conflicting output parameter ${arg.variableName}`);
                callerVariables.set(arg.variableName, value);
            }
        }
    }

    private serializeField(
        field: TLBField,
        value: unknown,
        builder: Builder,
        variables: Map<string, number | bigint>,
        typeParams?: Map<string, TLBFieldType>,
    ): void {
        if (
            field.name &&
            (field.fieldType.kind === 'TLBNumberType' ||
                field.fieldType.kind === 'TLBVarIntegerType' ||
                field.fieldType.kind === 'TLBBoolType')
        ) {
            variables.set(field.name, typeof value === 'bigint' ? value : Number(value));
        }

        this.serializeFieldType(field.fieldType, value, builder, variables, typeParams);
    }

    private bindTypeParameters(
        type: TLBFieldType,
        params: Map<string, TLBFieldType>,
        variables?: Map<string, number | bigint>,
    ): TLBFieldType {
        if ((type as ScopedField)[definingScope]) return type;
        if (variables && type.kind === 'TLBNamedType' && this.typeMap.get(type.name)?.isAnon) {
            const context = new ParameterContext();
            for (const [name, argument] of params) context.setType(name, argument);
            return { ...type, [definingScope]: { variables: new Map(variables), context } } as ScopedField;
        }
        if (!params.size && !variables) return type;
        if (type.kind === 'TLBNamedType') {
            return (
                params.get(type.name) ?? {
                    ...type,
                    arguments: type.arguments.map((arg) => this.bindTypeParameters(arg, params, variables)),
                }
            );
        }
        if ('value' in type && type.value && typeof type.value === 'object') {
            return { ...type, value: this.bindTypeParameters(type.value, params, variables) } as TLBFieldType;
        }
        return type;
    }

    private serializeDictionary(
        keySize: number,
        valueType: TLBFieldType,
        direct: boolean,
        value: Dictionary<DictionaryKeyTypes, DecodedCell> | Record<string, DecodedCell> | undefined,
        builder: Builder,
        variables: Map<string, number | bigint>,
    ): void {
        const dict = Dictionary.empty(Dictionary.Keys.BigUint(keySize), {
            serialize: (entry: DecodedCell, leaf: Builder) =>
                this.serializeFieldType(valueType, entry, leaf, new Map(variables)),
            parse: () => {
                throw new TLBDataError('Write-only dictionary codec');
            },
        });
        const entries = value instanceof Dictionary ? value : Object.entries(value ?? {});
        for (const [key, entry] of entries) {
            if (typeof key !== 'number' && typeof key !== 'bigint' && typeof key !== 'string') {
                throw new TLBDataError('Expected an integer dictionary key');
            }
            dict.set(BigInt(key), entry);
        }
        if (direct) builder.storeDictDirect(dict);
        else builder.storeDict(dict);
    }

    private serializeFieldType(
        fieldType: TLBFieldType,
        // FIXME
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        value: any,
        builder: Builder,
        variables: Map<string, number | bigint>,
        typeParams?: Map<string, TLBFieldType>,
    ): void {
        const evaluator = new MathExprEvaluator(variables);

        switch (fieldType.kind) {
            case 'TLBNumberType': {
                const bits = evaluator.evaluate(fieldType.bits);
                if (fieldType.upperBound) checkNatUpperBound(value, evaluator.evaluate(fieldType.upperBound));
                if (fieldType.signed) {
                    builder.storeInt(value, bits);
                } else {
                    builder.storeUint(value, bits);
                }
                break;
            }

            case 'TLBBoolType': {
                if (fieldType.value !== undefined) {
                    // Fixed value, nothing to store
                    break;
                }
                builder.storeBit(value ? 1 : 0);
                break;
            }

            case 'TLBBitsType': {
                const expectedBits = evaluator.evaluate(fieldType.bits);
                if (expectedBits === 1 && typeof value === 'boolean') {
                    builder.storeBit(value);
                    break;
                }
                if (typeof value === 'string') {
                    value = stringToBits(value);
                }
                if (value instanceof BitString) {
                    // Validate that BitString has the expected length
                    if (value.length !== expectedBits) {
                        throw new TLBDataError(
                            `BitString length mismatch: expected ${expectedBits} bits, got ${value.length} bits`,
                        );
                    }
                    builder.storeBits(value);
                } else {
                    throw new TLBDataError(`Value must be a string or BitString for bits type, got ${typeof value}`);
                }
                break;
            }

            case 'TLBNamedType': {
                if (fieldType.name === 'Any') {
                    builder.storeSlice(value.beginParse());
                    break;
                }

                // Handle Bool type: bool_false$0 (tag 0) and bool_true$1 (tag 1)
                if (fieldType.name === 'Bool') {
                    // Write the tag bit (0 for false, 1 for true)
                    builder.storeBit(value ? 1 : 0);
                    break;
                }

                // Handle Maybe type: nothing$0 (tag 0) or just$1 (tag 1) with value field
                if (fieldType.name === 'Maybe') {
                    const args = fieldType.arguments ?? [];
                    if (args.length < 1) {
                        throw new TLBDataError('Maybe requires one argument: the inner type (X)');
                    }

                    const maybe = this.typeMap.get('Maybe');
                    const kind = value?.kind;
                    if (typeof kind === 'string' && maybe?.constructors.some((c) => kind === 'Maybe_' + c.name)) {
                        this.serializeType(maybe, value, builder, args, variables);
                    } else {
                        // The legacy compiler also accepts Maybe without constructor declarations.
                        if (!maybe && kind === 'Maybe_nothing') {
                            builder.storeBit(false);
                            break;
                        }
                        if (!maybe && kind === 'Maybe_just' && !('value' in value)) {
                            throw new TLBDataError('Missing value in Maybe_just');
                        }
                        const present = value !== null && value !== undefined;
                        builder.storeBit(present);
                        if (present) {
                            const inner = !maybe && kind === 'Maybe_just' ? value.value : value;
                            this.serializeFieldType(args[0], inner, builder, variables);
                        }
                    }
                    break;
                }

                // Handle MsgAddress types: MsgAddress, MsgAddressInt, MsgAddressExt
                if (
                    fieldType.name === 'MsgAddress' ||
                    fieldType.name === 'MsgAddressInt' ||
                    fieldType.name === 'MsgAddressExt'
                ) {
                    writeAddress(builder, value, fieldType.name);
                    break;
                }

                if (fieldType.name === 'HashmapAugE' && value instanceof Dictionary) {
                    throw new TLBDataError('HashmapAugE requires explicit extras on the root and fork nodes');
                }
                // Handle HashmapE type: hme_empty$0 (empty dict) or hme_root$1 (store Hashmap in ref)
                if (fieldType.name === 'HashmapE') {
                    const args = fieldType.arguments ?? [];
                    if (args.length < 2) {
                        throw new TLBDataError('HashmapE requires two arguments: key size (n) and value type (X)');
                    }

                    // Extract key size (n) from first argument
                    const keySizeArg = args[0];
                    let keySize: number;
                    if (keySizeArg.kind === 'TLBExprMathType') {
                        keySize = evaluator.evaluate(keySizeArg.initialExpr);
                    } else if (keySizeArg.kind === 'TLBNumberType') {
                        keySize = evaluator.evaluate(keySizeArg.bits);
                    } else if (keySizeArg.kind === 'TLBNamedType' && keySizeArg.name) {
                        // Argument is a parameter reference (e.g., n)
                        const varValue = variables.get(keySizeArg.name);
                        if (varValue === undefined) {
                            throw new TLBDataError(
                                `Variable ${keySizeArg.name} not found for HashmapE key size argument`,
                            );
                        }
                        keySize = safeExpressionNumber(varValue);
                    } else {
                        throw new TLBDataError(
                            'HashmapE first argument must be a numeric expression or parameter reference',
                        );
                    }

                    // Extract value type (X) from second argument
                    const valueType = args[1];

                    this.serializeDictionary(keySize, valueType, false, value, builder, variables);
                    break;
                }

                // Handle #< n and #<= n limited nat types
                if (fieldType.name === '#<' || fieldType.name === '#<=') {
                    // Evaluate the argument (n) from type arguments
                    const args = fieldType.arguments ?? [];
                    if (args.length === 0) {
                        throw new TLBDataError(`${fieldType.name} requires an argument`);
                    }
                    const arg = args[0];
                    let n: number;
                    if (arg.kind === 'TLBExprMathType') {
                        n = evaluator.evaluate(arg.initialExpr);
                    } else if (arg.kind === 'TLBNumberType') {
                        n = evaluator.evaluate(arg.bits);
                    } else if (arg.kind === 'TLBNamedType' && arg.name) {
                        // Argument is a parameter reference (e.g., n)
                        const varValue = variables.get(arg.name);
                        if (varValue === undefined) {
                            throw new TLBDataError(`Variable ${arg.name} not found for ${fieldType.name} argument`);
                        }
                        n = safeExpressionNumber(varValue);
                    } else {
                        throw new TLBDataError(`Invalid argument type for ${fieldType.name}`);
                    }

                    // Calculate bit width
                    let bits: number;
                    if (fieldType.name === '#<') {
                        bits = MathExprEvaluator.calculateBitsForLessThan(n);
                    } else {
                        bits = MathExprEvaluator.calculateBitsForLessThanOrEqual(n);
                    }

                    checkNatUpperBound(value, fieldType.name === '#<' ? n - 1 : n);
                    builder.storeUint(value, bits);
                    break;
                }

                const type = this.typeMap.get(fieldType.name);
                if (!type) {
                    throw new TLBDataError(`Type ${fieldType.name} not found in TL-B schema`);
                }

                if (value !== undefined && value !== null && typeof value !== 'object') {
                    if (fieldType.name === 'VarUInteger') {
                        // VarUInteger n
                        // Argument n is required
                        if (!fieldType.arguments || fieldType.arguments.length < 1) {
                            throw new TLBDataError('VarUInteger requires argument n');
                        }
                        const nArg = fieldType.arguments[0];
                        let n: number;
                        // Use evaluator to get n. n uses variables from parent.
                        // We must ensure variables are populated.
                        // evaluator is constructed with variables.
                        if (nArg.kind === 'TLBExprMathType') {
                            n = evaluator.evaluate(nArg.initialExpr);
                        } else if (nArg.kind === 'TLBNumberType') {
                            n = evaluator.evaluate(nArg.bits);
                        } else if (nArg.kind === 'TLBNamedType' && nArg.name) {
                            const v = variables.get(nArg.name);
                            if (v === undefined)
                                throw new TLBDataError(`Variable ${nArg.name} not found for VarUInteger`);
                            n = safeExpressionNumber(v);
                        } else {
                            throw new TLBDataError('Invalid argument for VarUInteger');
                        }

                        const val = BigInt(value);
                        // Calculate minimal length in bytes
                        let len = 0;
                        if (val > 0n) {
                            // integer log256
                            len = 0;
                            let temp = val;
                            while (temp > 0n) {
                                temp >>= 8n;
                                len++;
                            }
                        }
                        // Construct object
                        // Constructor: var_uint$_ {n:#} len:(#< n) value:(uint (len * 8)) = VarUInteger n
                        value = {
                            kind: type.constructors.length === 1 ? undefined : 'var_uint',
                            n: n,
                            len: len,
                            value: val,
                        };
                    } else if (fieldType.name === 'VarInteger') {
                        // VarInteger n
                        if (!fieldType.arguments || fieldType.arguments.length < 1) {
                            throw new TLBDataError('VarInteger requires argument n');
                        }
                        const nArg = fieldType.arguments[0];
                        let n: number;
                        if (nArg.kind === 'TLBExprMathType') {
                            n = evaluator.evaluate(nArg.initialExpr);
                        } else if (nArg.kind === 'TLBNumberType') {
                            n = evaluator.evaluate(nArg.bits);
                        } else if (nArg.kind === 'TLBNamedType' && nArg.name) {
                            const v = variables.get(nArg.name);
                            if (v === undefined)
                                throw new TLBDataError(`Variable ${nArg.name} not found for VarInteger`);
                            n = safeExpressionNumber(v);
                        } else {
                            throw new TLBDataError('Invalid argument for VarInteger');
                        }

                        const val = BigInt(value);
                        // Calculate minimal length in bytes for signed
                        // Range for L bytes: -2^(8L-1) ... 2^(8L-1)-1
                        let len = 0;
                        if (val !== 0n) {
                            // Simple iterative check
                            // len=0 covers only 0? var_int logic says len bytes.
                            // If len=0, int0 is 0 bits? No, int(0) is empty?
                            // Yes, int(0) is 0 bits.
                            // But 0 can be stored in 0 bytes?
                            // If val=0, len=0.
                            if (val !== 0n) {
                                len = 1;
                                while (true) {
                                    const bits = BigInt(len * 8);
                                    const min = -(1n << (bits - 1n));
                                    const max = (1n << (bits - 1n)) - 1n;
                                    if (val >= min && val <= max) break;
                                    len++;
                                }
                            }
                        }

                        value = {
                            kind: type.constructors.length === 1 ? undefined : 'var_int',
                            n: n,
                            len: len,
                            value: val,
                        };
                    } else if (
                        fieldType.name === 'Coins' &&
                        type.constructors.length === 1 &&
                        type.constructors[0].fields.some(
                            (field) =>
                                field.name === 'grams' &&
                                field.fieldType.kind === 'TLBNamedType' &&
                                field.fieldType.name === 'Grams',
                        )
                    ) {
                        value = { grams: value };
                    } else if (fieldType.name === 'Grams') {
                        // Grams = nanograms$_ amount:(VarUInteger 16) = Grams
                        value = { kind: type.constructors.length === 1 ? undefined : 'nanograms', amount: value };
                    }
                }

                const scope = (fieldType as ScopedField)[definingScope];
                this.serializeType(
                    type,
                    value,
                    builder,
                    fieldType.arguments,
                    scope?.variables ?? variables,
                    scope?.context.getAllTypeParams() ?? typeParams,
                );
                break;
            }

            case 'TLBCoinsType': {
                builder.storeCoins(value);
                break;
            }

            case 'TLBAddressType':
                writeAddress(builder, value, fieldType.name);
                break;

            case 'TLBCellType': {
                builder.storeSlice(value.beginParse());
                break;
            }

            case 'TLBCellInsideType': {
                const nestedBuilder = beginCell();
                this.serializeFieldType(fieldType.value, value, nestedBuilder, variables, typeParams);
                builder.storeRef(nestedBuilder.endCell());
                break;
            }

            case 'TLBRefType': {
                // Cell reference: ^Type (where Type can be Cell or a user type name)
                // If inner type is TLBCellType, store the cell directly
                if (fieldType.value.kind === 'TLBCellType') {
                    if (value instanceof Cell) {
                        builder.storeRef(value);
                    } else {
                        throw new TLBDataError(
                            'Value must be a Cell instance for TLBRefType with TLBCellType inner type',
                        );
                    }
                    break;
                }

                // If inner type is TLBNamedType with name "Cell", store the cell directly
                if (fieldType.value.kind === 'TLBNamedType' && fieldType.value.name === 'Cell') {
                    if (value instanceof Cell) {
                        builder.storeRef(value);
                    } else {
                        throw new TLBDataError('Value must be a Cell instance for TLBRefType with Cell inner type');
                    }
                    break;
                }

                // Otherwise, serialize the inner type to a nested cell and store as ref
                const nestedBuilder = beginCell();
                this.serializeFieldType(fieldType.value, value, nestedBuilder, variables, typeParams);
                builder.storeRef(nestedBuilder.endCell());
                break;
            }

            case 'TLBHashmapType': {
                const keySize = evaluator.evaluate(fieldType.key);
                this.serializeDictionary(keySize, fieldType.value, !!fieldType.directStore, value, builder, variables);
                break;
            }

            case 'TLBVarIntegerType': {
                const size = evaluator.evaluate(fieldType.n);
                if (fieldType.signed) {
                    builder.storeVarInt(value, size);
                } else {
                    if (fieldType.upperBound) {
                        const n = BigInt(value);
                        const bytes = n === 0n ? 0 : Math.ceil(n.toString(16).length / 2);
                        if (bytes >= evaluator.evaluate(fieldType.upperBound))
                            throw new TLBDataError('VarUInteger byte length exceeds bound');
                    }
                    builder.storeVarUint(value, size);
                }
                break;
            }

            case 'TLBMultipleType': {
                const times = evaluator.evaluate(fieldType.times);
                for (let i = 0; i < times; i++) {
                    this.serializeFieldType(fieldType.value, value[i], builder, variables);
                }
                break;
            }

            case 'TLBCondType': {
                const condition = evaluator.evaluate(fieldType.condition);
                if (condition) {
                    this.serializeFieldType(fieldType.value, value, builder, variables);
                }
                break;
            }

            case 'TLBTupleType': {
                builder.storeSlice(serializeTuple(value).beginParse());
                break;
            }

            default:
                throw new TLBDataError(`Unsupported field type: ${fieldType.kind}`);
        }
    }

    private extractVariablesFromExpr(expr: _TLBMathExpr): Set<string> {
        const vars = new Set<string>();

        const collect = (e: _TLBMathExpr) => {
            if (e.kind === 'TLBVarExpr') {
                vars.add(e.x);
            } else if (e.kind === 'TLBBinaryOp') {
                collect(e.left);
                collect(e.right);
            } else if (e.kind === 'TLBUnaryOp') {
                collect(e.value);
            }
        };

        collect(expr);
        return vars;
    }

    private bindResultArguments(
        resultArguments: { expression: _TLBMathExpr; expected: number }[],
        variables: Map<string, number | bigint>,
        typeName: string,
        final = true,
    ): void {
        const evaluator = new MathExprEvaluator(variables);
        let solvedArgument: boolean;
        do {
            solvedArgument = false;
            for (const { expression, expected } of resultArguments) {
                const solved = this.solveEquality(
                    {
                        kind: 'TLBBinaryOp',
                        operation: '=',
                        left: expression,
                        right: { kind: 'TLBNumberExpr', n: expected },
                    },
                    variables,
                    evaluator,
                );
                if (solved) {
                    variables.set(solved.name, solved.value);
                    solvedArgument = true;
                }
            }
        } while (solvedArgument);
        for (const { expression, expected } of resultArguments) {
            const unknown = [...this.extractVariablesFromExpr(expression)].find(
                (name) => variables.get(name) === undefined,
            );
            if (unknown && !final) continue;
            if (unknown) throw new TLBDataError(`Cannot infer parameter ${unknown} for ${typeName}`);
            const actual = evaluator.evaluate(expression);
            if (actual !== expected) {
                throw new TLBDataError(
                    `Conflicting result parameter for ${typeName}: expected ${expected}, got ${actual}`,
                );
            }
        }
    }

    private solveConstraints(
        constraints: _TLBMathExpr[],
        variables: Map<string, number | bigint>,
        onBind?: (name: string, value: number) => void,
    ) {
        const evaluator = new MathExprEvaluator(variables);
        let changed: boolean;
        do {
            changed = false;
            for (const constraint of constraints) {
                const solved = this.solveEquality(constraint, variables, evaluator);
                if (!solved) continue;
                variables.set(solved.name, solved.value);
                onBind?.(solved.name, solved.value);
                changed = true;
            }
        } while (changed);
    }

    private solveEquality(
        expr: _TLBMathExpr,
        variables: Map<string, number | bigint>,
        evaluator: MathExprEvaluator,
    ): { name: string; value: number } | null {
        if (expr.kind !== 'TLBBinaryOp' || expr.operation !== '=') return null;

        const findUnknown = (e: _TLBMathExpr): string | null => {
            if (e.kind === 'TLBVarExpr') return variables.get(e.x) === undefined ? e.x : null;
            if (e.kind === 'TLBBinaryOp') return findUnknown(e.left) || findUnknown(e.right);
            if (e.kind === 'TLBUnaryOp') return findUnknown(e.value);
            return null;
        };

        const leftUnknown = findUnknown(expr.left);
        const rightUnknown = findUnknown(expr.right);

        // Can only solve if exactly one variable is unknown across both sides
        if (leftUnknown && rightUnknown) return null;
        if (!leftUnknown && !rightUnknown) return null;

        const unknownName = leftUnknown || rightUnknown!;
        const sideWithUnknown = leftUnknown ? expr.left : expr.right;
        const sideWithoutUnknown = leftUnknown ? expr.right : expr.left;

        let solvedValue: number | null;
        try {
            const targetValue = evaluator.evaluate(sideWithoutUnknown);
            // Simple solver for common TL-B equations: n = expr, expr = n, n + k = m, etc.
            const solve = (e: _TLBMathExpr, target: number): number | null => {
                if (e.kind === 'TLBVarExpr' && e.x === unknownName) return target;
                if (e.kind === 'TLBUnaryOp' && e.operation === '~') return solve(e.value, target);
                if (e.kind === 'TLBBinaryOp') {
                    if (e.operation === '+') {
                        try {
                            const leftVal = evaluator.evaluate(e.left);
                            return solve(e.right, target - leftVal);
                        } catch {
                            const rightVal = evaluator.evaluate(e.right);
                            return solve(e.left, target - rightVal);
                        }
                    }
                    if (e.operation === '*') {
                        const unknownOnLeft = findUnknown(e.left) !== null;
                        const factor = evaluator.evaluate(unknownOnLeft ? e.right : e.left);
                        if (factor === 0 || target % factor !== 0) return null;
                        return solve(unknownOnLeft ? e.left : e.right, target / factor);
                    }
                    if (e.operation === '-') {
                        try {
                            const leftVal = evaluator.evaluate(e.left);
                            return solve(e.right, leftVal - target);
                        } catch {
                            const rightVal = evaluator.evaluate(e.right);
                            return solve(e.left, target + rightVal);
                        }
                    }
                }
                return null;
            };

            solvedValue = solve(sideWithUnknown, targetValue);
        } catch {
            return null;
        }
        if (solvedValue === null) return null;
        if (!Number.isSafeInteger(solvedValue) || solvedValue < 0 || solvedValue > 0xffffffff)
            throw new TLBDataError(`Invalid natural parameter ${unknownName}: ${solvedValue}`);
        return { name: unknownName, value: solvedValue };
    }

    private loadBigInt(slice: Slice, bits: number, signed = false): bigint {
        if (signed) {
            return slice.loadIntBig(bits);
        }
        return slice.loadUintBig(bits);
    }
}

// Export a simple API for users
export function runtimeBySchema<T = TypedCell>(schema: string): TLBRuntime<T> {
    return unwrap(TLBRuntime.compile(schema));
}

export function runtimeBy<T = TypedCell>(schema: string | Cell, config?: Partial<TLBRuntimeConfig>): TLBRuntime<T> {
    if (typeof schema === 'string') return unwrap(TLBRuntime.compile<T>(schema, config));
    throw new TLBSchemaError('Not implemented');
}

/** @deprecated Use runtimeBy instead. */
export function parseTLB<T = ParsedCell>(schema: string): TLBRuntime<T> {
    return TLBRuntime.parseTLB<T>(schema);
}
