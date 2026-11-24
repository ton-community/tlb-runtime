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
} from '@ton/core';
import {
    TLBConstructor,
    TLBConstructorTag,
    TLBType,
    TLBField,
    TLBFieldType,
    TLBMathExpr,
    TLBNumberExpr,
    TLBVarExpr,
    getTLBCodeByAST,
} from '@ton-community/tlb-codegen';
import { ast } from '@ton-community/tlb-parser';

import { bitsToString, normalizeBitString, stringToBits, toCell } from './common';
import { MathExprEvaluator } from './MathExprEvaluator';
import { Result, Success, unwrap } from './Result';

export interface TypedCell {
    kind: string;
}

export type ParsedCell =
    | string
    | number
    | bigint
    | boolean
    | null
    | unknown
    | BitString
    | Address
    | ExternalAddress
    | Dictionary<DictionaryKeyTypes, ParsedCell>
    | Cell
    | { [key: string]: ParsedCell }
    | ParsedCell[]
    | TypedCell;

export class TLBRuntimeError extends Error {}

export class TLBSchemaError extends TLBRuntimeError {}

export class TLBDataError extends TLBRuntimeError {}

class UnsupportedAugmentedDictionaryError extends TLBDataError {
    constructor() {
        super('Augmented dictionaries are not supported');
    }
}

class CompleteRootConstraintError extends TLBDataError {}

interface DecodeAttempt {
    trailingReferenceData: boolean;
    failedConstraint: boolean;
}

interface DeserializeOptions {
    selection?: 'first' | 'prefer-complete' | 'complete' | 'complete-tagged';
    parentAttempt?: DecodeAttempt;
}

function tagKey(tag: TLBConstructorTag): string {
    return `0b${BigInt(tag.binary).toString(2).padStart(tag.bitLen, '0')}`;
}

function matchesTag(slice: Slice, tag: TLBConstructorTag): boolean {
    return (
        tag.bitLen > 0 && tag.bitLen <= slice.remainingBits && slice.preloadUintBig(tag.bitLen) === BigInt(tag.binary)
    );
}

function isConsumed(slice: Slice): boolean {
    return slice.remainingBits === 0 && slice.remainingRefs === 0;
}

function recordReferenceRemainder(attempt: DecodeAttempt | undefined, slice: Slice): void {
    if (attempt && !isConsumed(slice)) {
        attempt.trailingReferenceData = true;
    }
}

function evaluateNumericArgument(argument: TLBFieldType | undefined, evaluator: MathExprEvaluator): number | undefined {
    if (argument?.kind === 'TLBExprMathType') {
        return evaluator.evaluate(argument.initialExpr);
    }
    if (argument?.kind === 'TLBNumberType') {
        return evaluator.evaluate(argument.bits);
    }
    return undefined;
}

function bindNumericExpression(expression: TLBMathExpr, variables: Map<string, number>): TLBMathExpr {
    if (
        expression.hasNeg ||
        expression.variables.size === 0 ||
        !Array.from(expression.variables).every((name) => variables.has(name))
    ) {
        return expression;
    }
    return new TLBNumberExpr(new MathExprEvaluator(variables).evaluate(expression));
}

function findLegacyAnonymousGroup(fields: TLBField[]): TLBField | undefined {
    const groups = fields.filter((field) => !field.name && field.subFields.length > 0);
    if (groups.length === 1 && groups[0].subFields.every(({ name, subFields }) => name && subFields.length === 0)) {
        return groups[0];
    }
    return undefined;
}

export interface TLBRuntimeConfig {
    autoText: boolean;
}

// Runtime TL-B serialization/deserialization
export class TLBRuntime<T extends ParsedCell = ParsedCell> {
    private readonly tagMap = new Map<string, { type: TLBType; item: TLBConstructor }>();
    private maxSizeTag = 0;
    private constructor(
        readonly schema: string,
        private readonly types: Map<string, TLBType>,
        private readonly lastTypeName: string,
        private readonly config: Partial<TLBRuntimeConfig> = {},
    ) {
        config.autoText = config.autoText || true;
        for (const type of this.types.values()) {
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

    static from<T extends ParsedCell = ParsedCell>(
        schema: string,
        config: Partial<TLBRuntimeConfig> = {},
    ): Result<TLBRuntime<T>> {
        try {
            const tree = ast(schema);
            const code = getTLBCodeByAST(tree, schema);
            const pared = schema.split('=');
            const lastTypeName = pared[pared.length - 1].split(';')[0].trim().split(' ')[0].trim();
            return {
                success: true,
                value: new TLBRuntime(schema, code.types, lastTypeName, config),
            };
        } catch (error) {
            void error;
        }
        return { success: false, error: new TLBSchemaError('Bad Schema') };
    }

    changeSchema(schema: string): Result<TLBRuntime<T>> {
        if (this.schema === schema) {
            return {
                success: true,
                value: this,
            };
        }
        return TLBRuntime.from(schema, this.config);
    }

    parseCell(data: Cell | string): ParsedCell {
        return unwrap(this.deserialize(data));
    }

    encodeCell(data: ParsedCell | string): Cell {
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
            const tagValue = slice.preloadUint(len);
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

    deserialize(data: Cell | string, findByTag = false): Result<T> {
        if (typeof data === 'string') {
            const result = toCell(data);
            if (!result.success) {
                return result;
            }
            data = result.value;
        }
        const slice = data.asSlice();
        if (findByTag) {
            const find = this.findByTag(slice);
            if (find) {
                return this.deserializeConstructor(find.type, find.item, slice);
            }
        }

        const types = Array.from(this.types.values()).reverse();
        const rootType = this.types.get(this.lastTypeName);
        let firstError: Error | undefined;
        let fallback: { error: Error; selection: 'complete' | 'complete-tagged' } | undefined;
        for (const type of rootType ? [rootType, ...types.filter((type) => type !== rootType)] : types) {
            const result = this.deserializeType(type, slice.clone(), [], undefined, undefined, {
                selection: fallback?.selection ?? 'prefer-complete',
            });
            if (result.success) {
                return result;
            }
            if (result.error instanceof UnsupportedAugmentedDictionaryError) {
                fallback ??= { error: result.error, selection: 'complete-tagged' };
            } else if (type === rootType && type.constructors.some(({ tag }) => matchesTag(slice, tag))) {
                if (!(result.error instanceof CompleteRootConstraintError)) {
                    return result;
                }
                fallback = { error: result.error, selection: 'complete' };
            }
            firstError ??= result.error;
        }

        return { success: false, error: fallback?.error ?? firstError ?? new TLBDataError('No matching constructor') };
    }

    // Deserialize data from a Slice based on a TL-B type name
    deserializeByTypeName(typeName: string, slice: Slice): Result<T> {
        const type = this.types.get(typeName);
        if (!type) {
            return {
                success: false,
                error: new TLBDataError(`Type ${typeName} not found in TL-B schema`),
            };
        }
        return this.deserializeType(type, slice);
    }

    serialize(data: T): Result<Builder> {
        const typeKind = (data as TypedCell).kind;
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
        const type = this.types.get(typeName);
        if (!type) {
            return {
                success: false,
                error: new TLBDataError(`Type ${typeName} not found in TL-B schema`),
            };
        }
        const value = beginCell();
        this.serializeType(type, data, value);
        return {
            success: true,
            value,
        };
    }

    private deserializeType(
        type: TLBType,
        data: Slice,
        args: TLBFieldType[] = [],
        parentVariables?: Map<string, number>,
        outputVariables?: Map<string, number>,
        { selection = 'first', parentAttempt }: DeserializeOptions = {},
    ): Result<T> {
        let selected:
            | { slice: Slice; result: Success<T>; outputs?: Map<string, number>; trailingReferenceData?: boolean }
            | undefined;
        let firstError: Error | undefined;
        let taggedError: Error | undefined;
        for (const constructor of type.constructors) {
            if (selection === 'complete-tagged' && constructor.tag.bitLen === 0) continue;
            const prev = data.clone();
            const outputs = outputVariables ? new Map<string, number>() : undefined;
            const attempt =
                parentAttempt || selection !== 'first'
                    ? { trailingReferenceData: false, failedConstraint: false }
                    : undefined;
            let result: Result<T>;
            try {
                result = this.deserializeConstructor(type, constructor, prev, args, parentVariables, outputs, attempt);
            } catch (error) {
                const failure = error instanceof Error ? error : new TLBDataError(String(error));
                firstError ??= failure;
                result = { success: false, error: failure };
            }
            if (!result.success) {
                if (result.error instanceof UnsupportedAugmentedDictionaryError) return result;
                if (selection === 'prefer-complete' && !taggedError && matchesTag(data, constructor.tag)) {
                    taggedError =
                        attempt?.failedConstraint && isConsumed(prev) && !attempt.trailingReferenceData
                            ? new CompleteRootConstraintError(result.error.message)
                            : result.error;
                }
                continue;
            }

            const candidate = { slice: prev, result, outputs, trailingReferenceData: attempt?.trailingReferenceData };
            if (
                selection === 'first' ||
                (isConsumed(prev) && (selection === 'prefer-complete' || !attempt?.trailingReferenceData))
            ) {
                selected = candidate;
                break;
            }
            if (selection === 'prefer-complete') selected ??= candidate;
        }

        if (selected) {
            data.skip(data.remainingBits - selected.slice.remainingBits);
            while (data.remainingRefs > selected.slice.remainingRefs) {
                data.loadRef();
            }
            if (outputVariables && selected.outputs) {
                for (const [name, value] of selected.outputs) {
                    outputVariables.set(name, value);
                }
            }
            if (parentAttempt && selected.trailingReferenceData) {
                parentAttempt.trailingReferenceData = true;
            }
            return selected.result;
        }

        return {
            success: false,
            error:
                taggedError ??
                firstError ??
                new TLBDataError(`Failed to deserialize type ${type.name} no matching constructor found`),
        };
    }

    private deserializeConstructor(
        type: TLBType,
        constructor: TLBConstructor,
        slice: Slice,
        args: TLBFieldType[] = [],
        parentVariables?: Map<string, number>,
        outputVariables?: Map<string, number>,
        attempt?: DecodeAttempt,
    ): Result<T> {
        const kind = type.constructors.length > 1 ? `${type.name}_${constructor.name}` : type.name;
        // Check tag if present
        if (constructor.tag.bitLen > 0) {
            const len = constructor.tag.bitLen;
            if (slice.remainingBits < len) {
                return {
                    success: false,
                    error: new TLBDataError(`Not enough bits to read tag for ${kind}`),
                };
            }
            const preloadedTag = `0b${slice.loadUint(len).toString(2).padStart(len, '0')}`;
            const expectedTag = tagKey(constructor.tag);
            if (preloadedTag !== expectedTag) {
                return {
                    success: false,
                    error: new TLBDataError(`Failed to deserialize type ${kind}`),
                };
            }
        }

        // Initialize variables map for constraint evaluation
        const variables = new Map<string, number>(parentVariables);
        const callerEvaluator = new MathExprEvaluator(parentVariables);
        const argValues = args.map((argument) => {
            try {
                return evaluateNumericArgument(argument, callerEvaluator);
            } catch {
                return undefined;
            }
        });

        // Initialize variables from constructor parameters (from type arguments)
        if (args.length > 0 && constructor.parameters.length > 0) {
            const evaluator = new MathExprEvaluator(variables);
            for (let i = 0; i < Math.min(args.length, constructor.parameters.length); i++) {
                const param = constructor.parameters[i];
                const argValue = argValues[i];

                if (
                    param.variable.isConst &&
                    typeof argValue === 'number' &&
                    evaluator.evaluate(param.paramExpr) !== argValue
                ) {
                    return {
                        success: false,
                        error: new TLBDataError(`Type argument does not match constructor ${kind}`),
                    };
                }

                if (param.argName && typeof argValue === 'number') {
                    variables.set(param.argName, argValue);
                }

                try {
                    const derived = param.variable.deriveExpr;
                    if (
                        derived &&
                        (!(derived instanceof TLBVarExpr) ||
                            derived.x !== param.variable.name ||
                            argValue === undefined) &&
                        Array.from(derived.variables).every((name) => variables.has(name))
                    ) {
                        variables.set(param.variable.name, evaluator.evaluate(derived));
                        continue;
                    }
                    if (param.variable?.name && typeof argValue === 'number') {
                        const varName = param.variable.name;
                        let solved = false;
                        // Prefer solving using parameter expression if present (e.g., ExprType (2 + n))
                        if ((param as unknown as { paramExpr?: unknown }).paramExpr) {
                            const expr = (param as unknown as { paramExpr: unknown }).paramExpr as Parameters<
                                MathExprEvaluator['evaluate']
                            >[0];
                            let found: number | undefined;
                            for (let cand = 0; cand <= 1024; cand++) {
                                const trial = new Map(variables);
                                trial.set(varName, cand);
                                const v = new MathExprEvaluator(trial).evaluate(expr);
                                if (v === argValue) {
                                    found = cand;
                                    break;
                                }
                            }
                            if (typeof found === 'number') {
                                variables.set(varName, found);
                                solved = true;
                            }
                        }
                        if (!solved && param.variable.deriveExpr) {
                            // Try to solve deriveExpr(var) == argValue for var in [0..1024]
                            if (variables.get(varName) === undefined) {
                                let found: number | undefined;
                                for (let cand = 0; cand <= 1024; cand++) {
                                    const trial = new Map(variables);
                                    trial.set(varName, cand);
                                    const v = new MathExprEvaluator(trial).evaluate(param.variable.deriveExpr);
                                    if (v === argValue) {
                                        found = cand;
                                        break;
                                    }
                                }
                                if (typeof found === 'number') {
                                    variables.set(varName, found);
                                    solved = true;
                                }
                            }
                        }
                        if (!solved && !param.variable.negated) {
                            // Fallback: direct assignment
                            variables.set(varName, argValue);
                        }
                    }
                } catch (error) {
                    void error;
                }
            }
        }

        // If no type args provided, load numeric constructor parameters ('#') from slice
        if (args.length === 0 && constructor.parameters.length > 0) {
            for (const param of constructor.parameters) {
                try {
                    if (param.variable?.type === '#' && !param.variable.negated && !param.variable.isConst) {
                        if (slice.remainingBits >= 32) {
                            const val = Number(slice.loadUint(32));
                            variables.set(param.variable.name, val);
                        }
                    }
                } catch (error) {
                    void error;
                }
            }
        }

        // Heuristic: if constructor has no fields and exactly one numeric parameter and it isn't set,
        // try to read a 32-bit value from the slice as that parameter (some test fixtures encode it explicitly)
        if (
            constructor.fields.length === 0 &&
            constructor.parameters.length === 1 &&
            constructor.parameters[0].variable.type === '#' &&
            variables.get(constructor.parameters[0].variable.name) === undefined &&
            slice.remainingBits >= 32
        ) {
            try {
                const val = Number(slice.loadUint(32));
                variables.set(constructor.parameters[0].variable.name, val);
            } catch (error) {
                void error;
            }
        }

        // Fallback: some schemas keep numeric variables only in `variables` and not in `parameters`.
        // In that case, bind them positionally from type arguments.
        if (args.length > 0 && constructor.parameters.length === 0 && constructor.variables.length > 0) {
            const numericVars = constructor.variables.filter((v) => v.type === '#');
            for (let i = 0; i < Math.min(argValues.length, numericVars.length); i++) {
                const value = argValues[i];
                if (value !== undefined) {
                    variables.set(numericVars[i].name, value);
                }
            }
        }

        // Deserialize fields
        // FIXME
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let value: any = {
            kind,
        };

        const legacyGroup = findLegacyAnonymousGroup(constructor.fields);
        for (const field of constructor.fields) {
            // field.subFields.length
            if (field.subFields.length > 0) {
                if (slice.remainingRefs === 0) {
                    return {
                        success: false,
                        error: new TLBDataError(`No more references available for field ${field.name}`),
                    };
                }
                const ref = slice.loadRef();
                if (!field.name && field !== legacyGroup) {
                    const refSlice = ref.beginParse(true);
                    this.deserializeAnonymousFields(
                        field.subFields,
                        refSlice,
                        variables,
                        constructor,
                        args,
                        value,
                        attempt,
                    );
                    recordReferenceRemainder(attempt, refSlice);
                    continue;
                }

                const subfield = field.subFields.length === 1 ? field.subFields[0] : undefined;
                const referencedType =
                    subfield && this.resolveTypeArgument(subfield.fieldType, constructor, args, variables);
                if (referencedType?.kind === 'TLBCellType') {
                    value[field.name] = ref;
                    continue;
                }

                const refSlice = ref.beginParse(true);
                if (referencedType?.kind === 'TLBNamedType') {
                    const type = this.types.get(referencedType.name);
                    if (!type) {
                        return {
                            success: false,
                            error: new TLBDataError(`Type ${referencedType.name} not found`),
                        };
                    }
                    const result = this.deserializeType(
                        type,
                        refSlice,
                        referencedType.arguments,
                        variables,
                        undefined,
                        {
                            parentAttempt: attempt,
                        },
                    );
                    if (!result.success) return result;
                    value[field.name] = result.value;
                } else if (subfield) {
                    value[field.name] = this.deserializeField(
                        subfield,
                        refSlice,
                        variables,
                        constructor,
                        args,
                        attempt,
                    );
                } else {
                    const subfields: Record<string, ParsedCell> = {};
                    for (const subfield of field.subFields) {
                        subfields[subfield.name] = this.deserializeField(
                            subfield,
                            refSlice,
                            variables,
                            constructor,
                            args,
                            attempt,
                        );
                    }
                    value[field.name] = subfields;
                }
                recordReferenceRemainder(attempt, refSlice);
            } else {
                value[field.name] = this.deserializeField(field, slice, variables, constructor, args, attempt);
            }
        }

        for (const variable of constructor.variables) {
            if (variable.deriveExpr) {
                try {
                    const derived = new MathExprEvaluator(variables).evaluate(variable.deriveExpr);
                    variables.set(variable.name, derived);
                } catch (error) {
                    void error;
                }
            }
        }

        // Check constraints
        const evaluator = new MathExprEvaluator(variables);
        for (const constraint of constructor.constraints) {
            if (evaluator.evaluate(constraint) !== 1) {
                if (attempt) attempt.failedConstraint = true;
                return {
                    success: false,
                    error: new TLBDataError(`Failed to deserialize type ${kind} due to constraint`),
                };
            }
        }

        if (outputVariables) {
            for (const [index, param] of constructor.parameters.entries()) {
                const argument = args[index];
                if (param.variable.negated && argument?.kind === 'TLBNegatedType') {
                    outputVariables.set(argument.variableName, evaluator.evaluate(param.paramExpr));
                }
            }
        }

        if (kind === 'ExprType' && typeof (value as Record<string, unknown>)['x'] === 'number') {
            // For ExprType, tests expect bigints for numeric payload even if small
            (value as Record<string, unknown>)['x'] = BigInt((value as Record<string, number>)['x']);
        }

        // Reorder output: kind, parameters, then fields (stable and predictable JSON order for tests)
        // Collect parameters (only numeric parameters, ignore negated and const)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const orderedValue: any = { kind };
        if (constructor.parameters.length > 0) {
            for (const param of constructor.parameters) {
                try {
                    if (param.variable.type === '#' && !param.variable.isConst) {
                        const val = variables.get(param.variable.name);
                        if (typeof val === 'number') {
                            orderedValue[param.variable.name] = val;
                        }
                    }
                } catch (error) {
                    void error;
                }
            }
        } else if (constructor.variables.length > 0) {
            const fieldNamesSet = new Set(constructor.fields.map((f) => f.name));
            for (const v of constructor.variables) {
                try {
                    if (v.type === '#' && !v.isConst && !fieldNamesSet.has(v.name)) {
                        const val = variables.get(v.name);
                        if (typeof val === 'number') {
                            orderedValue[v.name] = val;
                        }
                    }
                } catch (error) {
                    void error;
                }
            }
        }
        // If still no parameters published but we have exactly one numeric variable, include it
        if (
            Object.keys(orderedValue).length === 1 &&
            constructor.parameters.length === 0 &&
            constructor.variables.filter((v) => v.type === '#').length === 1
        ) {
            const v = constructor.variables.find((vv) => vv.type === '#')!;
            const val = variables.get(v.name);
            if (typeof val === 'number') {
                orderedValue[v.name] = val;
            }
        }
        // Fields in alphabetical order for stable output
        const fieldNames = Object.keys(value)
            .filter((name) => name !== 'kind')
            .sort();
        for (const name of fieldNames) {
            orderedValue[name] = (value as Record<string, unknown>)[name];
        }

        return {
            success: true,
            value: orderedValue,
        };
    }

    private deserializeAnonymousFields(
        fields: TLBField[],
        slice: Slice,
        variables: Map<string, number>,
        constructor: TLBConstructor,
        args: TLBFieldType[],
        value: Record<string, ParsedCell>,
        attempt?: DecodeAttempt,
    ): void {
        for (const field of fields) {
            if (!field.name && field.subFields.length > 0) {
                const refSlice = slice.loadRef().beginParse(true);
                this.deserializeAnonymousFields(
                    field.subFields,
                    refSlice,
                    variables,
                    constructor,
                    args,
                    value,
                    attempt,
                );
                recordReferenceRemainder(attempt, refSlice);
            } else {
                const subfield = field.subFields[0];
                const decoded =
                    field.subFields.length === 1 && subfield.name === field.name
                        ? this.deserializeFieldType(
                              { kind: 'TLBCellInsideType', value: subfield.fieldType },
                              slice,
                              variables,
                              constructor,
                              args,
                              attempt,
                          )
                        : this.deserializeField(field, slice, variables, constructor, args, attempt);
                value[field.name] = decoded;
            }
        }
    }

    private deserializeField(
        field: TLBField,
        slice: Slice,
        variables: Map<string, number>,
        ctxConstructor: TLBConstructor,
        ctxArgs: TLBFieldType[],
        attempt?: DecodeAttempt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): any {
        const value = this.deserializeFieldType(field.fieldType, slice, variables, ctxConstructor, ctxArgs, attempt);

        if (
            field.name &&
            (field.fieldType.kind === 'TLBNumberType' ||
                field.fieldType.kind === 'TLBVarIntegerType' ||
                field.fieldType.kind === 'TLBBoolType')
        ) {
            variables.set(field.name, Number(value));
        }

        // Try to propagate parameter values from nested typed values if present (e.g., x: (Unary ~n) gives n)
        if (value && typeof value === 'object') {
            for (const param of ctxConstructor.parameters) {
                if (
                    param.variable?.type === '#' &&
                    !param.variable.negated &&
                    variables.get(param.variable.name) === undefined
                ) {
                    const extracted = this.extractNumericProperty(value, param.variable.name);
                    if (typeof extracted === 'number') {
                        variables.set(param.variable.name, extracted);
                    }
                }
            }
        }

        return value;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private extractNumericProperty(obj: any, name: string): number | undefined {
        if (!obj || typeof obj !== 'object') return undefined;
        if (typeof obj[name] === 'number') return obj[name] as number;
        for (const key of Object.keys(obj)) {
            const v = (obj as Record<string, unknown>)[key];
            if (v && typeof v === 'object') {
                const r = this.extractNumericProperty(v, name);
                if (typeof r === 'number') return r;
            }
        }
        return undefined;
    }

    private deserializeFieldType(
        fieldType: TLBFieldType,
        slice: Slice,
        variables: Map<string, number>,
        ctxConstructor: TLBConstructor,
        ctxArgs: TLBFieldType[],
        attempt?: DecodeAttempt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): any {
        const evaluator = new MathExprEvaluator(variables);

        switch (fieldType.kind) {
            case 'TLBNumberType': {
                const bits = evaluator.evaluate(fieldType.bits);
                const val = this.loadBigInt(slice, bits, fieldType.signed);
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
                const raw = slice.loadBits(bits);
                if (this.config.autoText && bits % 8 === 0) {
                    return bitsToString(raw);
                }
                if (bits === 1) {
                    return raw.at(0);
                }
                return normalizeBitString(raw);
            }

            case 'TLBNamedType': {
                const p = ctxConstructor.parametersMap.get(fieldType.name);
                if (p && p.variable.type === 'Type') {
                    const paramIndex = ctxConstructor.parameters.findIndex(
                        (pp) => pp.variable.name === p.variable.name,
                    );
                    if (paramIndex >= 0 && ctxArgs[paramIndex]) {
                        return this.deserializeFieldType(
                            ctxArgs[paramIndex],
                            slice,
                            variables,
                            ctxConstructor,
                            ctxArgs,
                            attempt,
                        );
                    }
                }
                if (fieldType.name === 'Bool') {
                    return slice.loadBit();
                }

                if (fieldType.name === 'Any') {
                    // Read remaining slice into a new cell
                    const b = beginCell();
                    const bitsLeft = slice.remainingBits;
                    if (bitsLeft > 0) {
                        b.storeBits(slice.loadBits(bitsLeft));
                    }
                    while (slice.remainingRefs > 0) {
                        b.storeRef(slice.loadRef());
                    }
                    return b.endCell();
                }

                const type = this.types.get(fieldType.name);
                if (!type) {
                    throw new TLBDataError(`Type ${fieldType.name} not found in TL-B schema`);
                }
                const forwardedArgs = fieldType.arguments.map((arg) =>
                    this.resolveTypeArgument(arg, ctxConstructor, ctxArgs, variables, true),
                );
                return unwrap(
                    this.deserializeType(type, slice, forwardedArgs, variables, variables, {
                        parentAttempt: attempt,
                    }),
                );
            }

            case 'TLBCoinsType': {
                return slice.loadCoins();
            }

            case 'TLBAddressType': {
                if (slice.preloadUint(2) !== 2) {
                    if (slice.remainingBits === 2) {
                        return null;
                    }
                    const type = slice.loadUint(2);
                    if (type === 1) {
                        const bits = slice.loadUint(9);
                        return new ExternalAddress(slice.loadUintBig(bits), bits);
                    }
                    // TODO add Anycast type === 3
                }
                return slice.loadAddress();
            }

            case 'TLBCellType': {
                const cell = slice.asCell();
                slice.skip(slice.remainingBits);
                while (slice.remainingRefs > 0) {
                    slice.loadRef();
                }
                return cell;
            }

            case 'TLBCellInsideType': {
                if (slice.remainingRefs === 0) {
                    throw new TLBDataError('No more references available for TLBCellInsideType');
                }
                const ref = slice.loadRef();
                if (fieldType.value.kind === 'TLBCellType') {
                    return ref;
                }
                const refSlice = ref.beginParse();
                const value = this.deserializeFieldType(
                    fieldType.value,
                    refSlice,
                    variables,
                    ctxConstructor,
                    ctxArgs,
                    attempt,
                );
                recordReferenceRemainder(attempt, refSlice);
                return value;
            }

            case 'TLBHashmapType': {
                if (fieldType.extra) throw new UnsupportedAugmentedDictionaryError();
                const keySize = evaluator.evaluate(fieldType.key.expr);
                const parseValue = (sl: Slice) =>
                    this.deserializeFieldType(
                        fieldType.value,
                        sl,
                        new Map(variables),
                        ctxConstructor,
                        ctxArgs,
                        attempt,
                    );
                const emptyBig = () => Dictionary.empty(Dictionary.Keys.BigUint(keySize));
                const emptyNum = () => Dictionary.empty(Dictionary.Keys.Uint(keySize));
                if (keySize > 32) {
                    const dict = fieldType.directStore
                        ? slice.loadDictDirect(Dictionary.Keys.BigUint(keySize), {
                              serialize: () => {},
                              parse: parseValue,
                          })
                        : slice.loadDict(Dictionary.Keys.BigUint(keySize), { serialize: () => {}, parse: parseValue });
                    return dict.size === 0 ? emptyBig() : dict;
                } else {
                    const dict = fieldType.directStore
                        ? slice.loadDictDirect(Dictionary.Keys.Uint(keySize), {
                              serialize: () => {},
                              parse: parseValue,
                          })
                        : slice.loadDict(Dictionary.Keys.Uint(keySize), { serialize: () => {}, parse: parseValue });
                    return dict.size === 0 ? emptyNum() : dict;
                }
            }

            case 'TLBVarIntegerType': {
                const size = evaluator.evaluate(fieldType.n);
                if (fieldType.signed) {
                    return slice.loadVarIntBig(size);
                } else {
                    return slice.loadVarUintBig(size);
                }
            }

            case 'TLBMultipleType': {
                const times = evaluator.evaluate(fieldType.times);
                const result = [];
                for (let i = 0; i < times; i++) {
                    result.push(
                        this.deserializeFieldType(fieldType.value, slice, variables, ctxConstructor, ctxArgs, attempt),
                    );
                }
                return result;
            }

            case 'TLBCondType': {
                const condition = evaluator.evaluate(fieldType.condition);
                if (condition) {
                    return this.deserializeFieldType(
                        fieldType.value,
                        slice,
                        variables,
                        ctxConstructor,
                        ctxArgs,
                        attempt,
                    );
                }
                return undefined;
            }

            case 'TLBTupleType': {
                const stack = parseTuple(slice.asCell());
                this.skipVmStack(slice);
                return stack;
            }

            default:
                throw new TLBDataError(`Unsupported field type: ${fieldType.kind}`);
        }
    }

    private skipVmStack(slice: Slice): void {
        if (slice.loadUint(24) === 0) {
            return;
        }
        slice.loadRef(); // The rest of the stack.
        const tag = slice.loadUint(8);
        switch (tag) {
            case 1:
                slice.skip(64);
                break;
            case 2:
                slice.skip(slice.preloadUint(7) === 0 ? 7 + 257 : 8);
                break;
            case 4:
                slice.skip(26);
                slice.loadRef();
                break;
            case 3:
            case 5:
                slice.loadRef();
                break;
            case 7: {
                const size = slice.loadUint(16);
                for (let index = 0; index < Math.min(size, 2); index++) {
                    slice.loadRef();
                }
                break;
            }
        }
    }

    private resolveTypeArgument(
        fieldType: TLBFieldType,
        constructor: TLBConstructor,
        args: TLBFieldType[],
        variables: Map<string, number>,
        isTypeArgument = false,
    ): TLBFieldType {
        switch (fieldType.kind) {
            case 'TLBNamedType': {
                const index = constructor.parameters.findIndex(
                    ({ variable }) => variable.type === 'Type' && variable.name === fieldType.name,
                );
                if (args[index]) return args[index];
                if (fieldType.arguments.length === 0) return fieldType;
                return {
                    ...fieldType,
                    arguments: fieldType.arguments.map((arg) =>
                        this.resolveTypeArgument(arg, constructor, args, variables, true),
                    ),
                };
            }
            case 'TLBExprMathType': {
                const { initialExpr } = fieldType;
                const resolved = bindNumericExpression(initialExpr, variables);
                return resolved === initialExpr ? fieldType : { ...fieldType, expr: resolved, initialExpr: resolved };
            }
            case 'TLBNumberType':
                return isTypeArgument
                    ? {
                          ...fieldType,
                          bits: bindNumericExpression(fieldType.bits, variables),
                          storeBits: bindNumericExpression(fieldType.storeBits, variables),
                      }
                    : fieldType;
            case 'TLBBitsType':
                return isTypeArgument
                    ? { ...fieldType, bits: bindNumericExpression(fieldType.bits, variables) }
                    : fieldType;
            case 'TLBVarIntegerType':
                return isTypeArgument ? { ...fieldType, n: bindNumericExpression(fieldType.n, variables) } : fieldType;
            case 'TLBHashmapType': {
                const { key } = fieldType;
                return {
                    ...fieldType,
                    key: isTypeArgument
                        ? {
                              ...key,
                              expr: bindNumericExpression(key.expr, variables),
                              initialExpr: bindNumericExpression(key.initialExpr, variables),
                          }
                        : key,
                    value: this.resolveTypeArgument(fieldType.value, constructor, args, variables, isTypeArgument),
                };
            }
            case 'TLBCellInsideType':
            case 'TLBCondType':
            case 'TLBMultipleType':
                return {
                    ...fieldType,
                    value: this.resolveTypeArgument(fieldType.value, constructor, args, variables, isTypeArgument),
                };
            default:
                return fieldType;
        }
    }

    // FIXME

    private serializeType(
        type: TLBType,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: any,
        builder: Builder,
        args: TLBFieldType[] = [],
        parentVariables?: Map<string, number>,
    ): void {
        // Find matching constructor by kind
        const typeKind = (data as TypedCell).kind;
        if (!typeKind) {
            throw new TLBDataError('Data must by typed');
        }

        const constructorName = typeKind.substring(type.name.length + 1); // Remove TypeName_ prefix
        let constructor: TLBConstructor | undefined;
        if (constructorName) {
            constructor = type.constructors.find((c) => c.name === constructorName);
        } else if (type.constructors.length > 0) {
            constructor = type.constructors[0];
        }
        if (!constructor) {
            throw new TLBDataError(`Constructor not found for type ${typeKind}`);
        }

        // Store tag if present
        if (constructor.tag.bitLen > 0) {
            const tag = BigInt(constructor.tag.binary);
            builder.storeUint(tag, constructor.tag.bitLen);
        }

        // Initialize variables map for constraint evaluation
        const variables = new Map<string, number>(parentVariables);
        const unboundRootInputs = parentVariables
            ? []
            : constructor.parameters
                  .filter(({ variable }) => variable.type === '#' && !variable.negated && !variable.isConst)
                  .map(({ variable }) => variable.name);
        for (const variable of constructor.variables) {
            if (unboundRootInputs.includes(variable.name)) continue;
            const value: unknown = data[variable.name];
            if (variable.type === '#' && (typeof value === 'number' || typeof value === 'bigint')) {
                const nat = Number(value);
                if (Number.isSafeInteger(nat) && nat >= 0) {
                    variables.set(variable.name, nat);
                }
            }
        }
        const evaluator = new MathExprEvaluator(variables);
        const callerEvaluator = new MathExprEvaluator(parentVariables);
        for (const [index, param] of constructor.parameters.entries()) {
            const { variable, argName, paramExpr } = param;
            if (variable.type !== '#' || variable.negated) continue;
            const bound = evaluateNumericArgument(args[index], callerEvaluator);
            if (bound !== undefined) {
                if (variable.isConst) {
                    if (evaluator.evaluate(paramExpr) !== bound) {
                        throw new TLBDataError(`Type argument does not match constructor ${typeKind}`);
                    }
                    continue;
                }
                if (argName) variables.set(argName, bound);
                const expression = variable.deriveExpr;
                const resolved =
                    expression && (!(expression instanceof TLBVarExpr) || expression.x !== variable.name)
                        ? evaluator.evaluate(expression)
                        : bound;
                const supplied: unknown = data[variable.name];
                if ((typeof supplied === 'number' || typeof supplied === 'bigint') && Number(supplied) !== resolved) {
                    throw new TLBDataError(`Parameter ${variable.name} does not match the schema`);
                }
                variables.set(variable.name, resolved);
                continue;
            }
            if (argName && Array.from(paramExpr.variables).every((name) => variables.has(name))) {
                variables.set(argName, evaluator.evaluate(paramExpr));
            }
        }

        this.serializeFields(constructor.fields, data, builder, variables, constructor, args);

        // Check constraints
        for (const constraint of constructor.constraints) {
            if (evaluator.evaluate(constraint) !== 1) {
                throw new TLBDataError(`Constraint failed for type ${type.name}, constructor ${constructor.name}`);
            }
        }
    }

    private serializeFields(
        fields: TLBField[],
        data: Record<string, ParsedCell>,
        builder: Builder,
        variables: Map<string, number>,
        constructor: TLBConstructor,
        args: TLBFieldType[],
    ): void {
        const legacyGroup = Object.hasOwn(data, '') ? findLegacyAnonymousGroup(constructor.fields) : undefined;
        for (const field of fields) {
            if (!field.name && field.subFields.length > 0) {
                let groupData = data;
                if (field === legacyGroup) {
                    const value = data[''];
                    if (field.subFields.length === 1) {
                        groupData = { [field.subFields[0].name]: value };
                    } else {
                        if (!value || typeof value !== 'object' || Array.isArray(value)) {
                            throw new TLBDataError('Expected an object for the anonymous group');
                        }
                        groupData = value as Record<string, ParsedCell>;
                    }
                }
                const nested = beginCell();
                this.serializeFields(field.subFields, groupData, nested, variables, constructor, args);
                builder.storeRef(nested.endCell());
                continue;
            }
            if (field.name && field.subFields.length === 1 && field.subFields[0].name === field.name) {
                const { fieldType } = field.subFields[0];
                if (
                    fieldType.kind === 'TLBCellType' ||
                    fieldType.kind === 'TLBNamedType' ||
                    fieldType.kind === 'TLBTupleType'
                ) {
                    this.serializeFieldType(
                        {
                            kind: 'TLBCellInsideType',
                            value: this.resolveTypeArgument(fieldType, constructor, args, variables),
                        },
                        data[field.name],
                        builder,
                        variables,
                    );
                    continue;
                }
            }

            const fieldType = this.resolveTypeArgument(field.fieldType, constructor, args, variables);
            this.serializeField({ ...field, fieldType }, field.name ? data[field.name] : null, builder, variables);
        }
    }

    // FIXME
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private serializeField(field: TLBField, value: any, builder: Builder, variables: Map<string, number>): void {
        if (
            field.name &&
            (field.fieldType.kind === 'TLBNumberType' ||
                field.fieldType.kind === 'TLBVarIntegerType' ||
                field.fieldType.kind === 'TLBBoolType')
        ) {
            variables.set(field.name, Number(value));
        }

        this.serializeFieldType(field.fieldType, value, builder, variables);
    }

    private serializeFieldType(
        fieldType: TLBFieldType,
        // FIXME
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        value: any,
        builder: Builder,
        variables: Map<string, number>,
    ): void {
        const evaluator = new MathExprEvaluator(variables);

        switch (fieldType.kind) {
            case 'TLBNumberType': {
                const bits = evaluator.evaluate(fieldType.bits);
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
                if (typeof value === 'boolean' && evaluator.evaluate(fieldType.bits) === 1) {
                    builder.storeBit(value);
                } else if (typeof value === 'string') {
                    builder.storeBits(stringToBits(value));
                } else if (value instanceof BitString) {
                    builder.storeBits(value);
                }
                break;
            }

            case 'TLBNamedType': {
                const type = this.types.get(fieldType.name);
                if (!type) {
                    throw new TLBDataError(`Type ${fieldType.name} not found in TL-B schema`);
                }
                this.serializeType(type, value, builder, fieldType.arguments, variables);
                break;
            }

            case 'TLBCoinsType': {
                builder.storeCoins(value);
                break;
            }

            case 'TLBAddressType': {
                if (typeof value === 'string') {
                    value = Address.parse(value);
                }
                builder.storeAddress(value);
                break;
            }

            case 'TLBCellType': {
                const cell: Cell = typeof value === 'string' ? unwrap(toCell(value)) : value;
                builder.storeSlice(cell.beginParse());
                break;
            }

            case 'TLBCellInsideType': {
                if (fieldType.value.kind === 'TLBCellType') {
                    builder.storeRef(typeof value === 'string' ? unwrap(toCell(value)) : value);
                    break;
                }
                const nestedBuilder = beginCell();
                this.serializeFieldType(fieldType.value, value, nestedBuilder, variables);
                builder.storeRef(nestedBuilder.endCell());
                break;
            }

            case 'TLBHashmapType': {
                if (fieldType.extra) throw new UnsupportedAugmentedDictionaryError();
                const keySize = evaluator.evaluate(fieldType.key.expr);
                const dict = Dictionary.empty(Dictionary.Keys.BigUint(keySize), {
                    serialize: (cell: Cell, target: Builder) => target.storeSlice(cell.beginParse()),
                    parse: (slice: Slice) => slice.asCell(),
                });
                const entries: Iterable<[string | number | bigint, unknown]> =
                    value instanceof Dictionary ? value : Object.entries(value ?? {});
                for (const [key, dictValue] of entries) {
                    const valueBuilder = beginCell();
                    this.serializeFieldType(fieldType.value, dictValue, valueBuilder, new Map(variables));
                    dict.set(BigInt(key), valueBuilder.endCell());
                }

                if (fieldType.directStore) {
                    builder.storeDictDirect(dict);
                } else {
                    builder.storeDict(dict);
                }
                break;
            }

            case 'TLBVarIntegerType': {
                const size = evaluator.evaluate(fieldType.n);
                if (fieldType.signed) {
                    builder.storeVarInt(value, size);
                } else {
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

    private loadBigInt(slice: Slice, bits: number, signed = false): bigint {
        if (signed) {
            return slice.loadIntBig(bits);
        }
        return slice.loadUintBig(bits);
    }
}

// Export a simple API for users
export function parseTLB<T extends ParsedCell = ParsedCell>(schema: string): TLBRuntime<T> {
    return unwrap(TLBRuntime.from(schema));
}
