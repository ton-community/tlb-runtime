import { ast } from '@ton-community/tlb-parser';
import * as legacy from '@ton-community/tlb-codegen';

import type { TLBBinaryOp, TLBUnaryOp, TLBField, TLBFieldType, TLBMathExpr, TLBType, TLBVariable } from './types';

// Codegen represents expressions as class instances; the codec uses tagged records.
function expression(expr: legacy.TLBMathExpr): TLBMathExpr {
    if (expr instanceof legacy.TLBNumberExpr) return { kind: 'TLBNumberExpr', n: expr.n };
    if (expr instanceof legacy.TLBVarExpr) return { kind: 'TLBVarExpr', x: expr.x };
    if (expr instanceof legacy.TLBUnaryOp) {
        return {
            kind: 'TLBUnaryOp',
            operation: expr.operation as TLBUnaryOp['operation'],
            value: expression(expr.value),
        };
    }
    return {
        kind: 'TLBBinaryOp',
        operation: expr.operation as TLBBinaryOp['operation'],
        left: expression(expr.left),
        right: expression(expr.right),
    };
}

function fieldType(type: legacy.TLBFieldType): TLBFieldType {
    switch (type.kind) {
        case 'TLBAddressType':
            return {
                ...type,
                name:
                    type.addrType === 'Internal'
                        ? 'MsgAddressInt'
                        : type.addrType === 'External'
                          ? 'MsgAddressExt'
                          : 'MsgAddress',
            };
        case 'TLBNumberType': {
            const bits = expression(type.bits);
            // Codegen represents bounded naturals as bitLength(maximum) for both reading and writing.
            const bounded = type.storeBits === type.bits && bits.kind === 'TLBUnaryOp' && bits.operation === '.';
            return {
                kind: type.kind,
                signed: type.signed,
                // Alpha.4 uses the variable itself as the width of (#<= n).
                bits: bounded && bits.value.kind === 'TLBVarExpr' ? bits.value : bits,
                maxBits: type.maxBits,
                ...(bounded && { upperBound: bits.value }),
            };
        }
        case 'TLBBitsType':
            return { ...type, bits: expression(type.bits) };
        case 'TLBVarIntegerType':
            return { ...type, n: expression(type.n) };
        case 'TLBExprMathType':
            return { kind: type.kind, initialExpr: expression(type.initialExpr) };
        case 'TLBNamedType':
            return { ...type, arguments: type.arguments.map(fieldType) };
        case 'TLBHashmapType':
            return {
                kind: type.kind,
                key: expression(type.key.expr),
                value: fieldType(type.value),
                directStore: type.directStore,
            };
        case 'TLBMultipleType':
            return { ...type, times: expression(type.times), value: fieldType(type.value) };
        case 'TLBCondType':
            return { ...type, condition: expression(type.condition), value: fieldType(type.value) };
        case 'TLBCellInsideType':
            return { ...type, value: fieldType(type.value) };
        default:
            return type;
    }
}

function field(f: legacy.TLBField): TLBField {
    const subFields = f.subFields.map(field);
    if (f.name && subFields.length === 1 && subFields[0].name === f.name && !subFields[0].subFields.length) {
        return { ...f, fieldType: { kind: 'TLBCellInsideType', value: subFields[0].fieldType }, subFields: [] };
    }
    return { ...f, fieldType: fieldType(f.fieldType), subFields };
}

function variable(v: legacy.TLBVariable): TLBVariable {
    return { ...v, deriveExpr: v.deriveExpr && expression(v.deriveExpr) };
}

// Ask the legacy compiler for its public property spelling only when an alias is supplied.
export function legacyFieldName(name: string): string | undefined {
    return legacy.getTLBCode(`_ ${name}:uint8 = Alias;`).types.get('Alias')?.constructors[0].fields[0]?.name;
}

export function compileLegacySchema(schema: string) {
    const tree = ast(schema);
    const types = new Map<string, TLBType>();
    for (const [name, type] of legacy.getTLBCodeByAST(tree, schema).types) {
        const constructors = type.constructors.map((constructor) => {
            const variables = constructor.variables.map(variable);
            const parameters = constructor.parameters.map((p) => ({
                variable: variable(p.variable),
                paramExpr: expression(p.paramExpr),
                argName: p.argName,
            }));
            return {
                ...constructor,
                fields: constructor.fields.map(field),
                constraints: constructor.constraints.map(expression),
                variables,
                variablesMap: new Map(variables.map((v) => [v.name, v])),
                parameters,
                parametersMap: new Map(parameters.map((p) => [p.variable.name, p])),
            };
        });
        types.set(name, { name, constructors });
    }
    return { types, lastTypeName: tree.declarations.at(-1)?.combinator.name };
}
