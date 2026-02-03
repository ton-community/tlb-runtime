/**
 * TL-B Type System Definitions
 * These types represent the structure of TL-B schema elements for runtime serialization/deserialization
 */

// Math expression types used by MathExprEvaluator
export type TLBNumberExpr = {
    kind: 'TLBNumberExpr';
    n: number;
};

export type TLBVarExpr = {
    kind: 'TLBVarExpr';
    x: string;
};

export type TLBBinaryOp = {
    kind: 'TLBBinaryOp';
    operation:
        | '+'
        | '-'
        | '*'
        | '/'
        | '%'
        | '<<'
        | '>>'
        | '&'
        | '|'
        | '^'
        | '=='
        | '!='
        | '<'
        | '<='
        | '>'
        | '>='
        | '='
        | '.';
    left: TLBMathExpr;
    right: TLBMathExpr;
};

export type TLBUnaryOp = {
    kind: 'TLBUnaryOp';
    operation: '-' | '~' | '!' | '.';
    value: TLBMathExpr;
};

export type TLBMathExpr = TLBNumberExpr | TLBVarExpr | TLBBinaryOp | TLBUnaryOp;

// Constructor tag
export interface TLBConstructorTag {
    bitLen: number;
    binary: string; // hex string prefixed with 0x or binary prefixed with 0b
}

// Field types
export interface TLBNumberType {
    kind: 'TLBNumberType';
    bits: TLBMathExpr;
    signed: boolean;
    maxBits?: number; // for #<= and #< types
    storeBits?: number;
}

export interface TLBBitsType {
    kind: 'TLBBitsType';
    bits: TLBMathExpr;
}

export interface TLBNamedType {
    kind: 'TLBNamedType';
    name: string;
    arguments: TLBFieldType[];
}

export interface TLBRefType {
    kind: 'TLBRefType';
    value: TLBFieldType;
}

export interface TLBExprMathType {
    kind: 'TLBExprMathType';
    initialExpr: TLBMathExpr;
}

export interface TLBVarIntegerType {
    kind: 'TLBVarIntegerType';
    n: TLBMathExpr;
    signed: boolean;
}

export interface TLBAddressType {
    kind: 'TLBAddressType';
}

export interface TLBCellType {
    kind: 'TLBCellType';
}

export interface TLBBoolType {
    kind: 'TLBBoolType';
    value?: TLBFieldType;
}

export interface TLBConditionalType {
    kind: 'TLBConditionalType';
    condition: TLBMathExpr;
    value: TLBFieldType;
}

export interface TLBMultipleType {
    kind: 'TLBMultipleType';
    times: TLBMathExpr;
    value: TLBFieldType;
}

export interface TLBCoinsType {
    kind: 'TLBCoinsType';
}

export interface TLBCellInsideType {
    kind: 'TLBCellInsideType';
    value: TLBFieldType;
}

export interface TLBHashmapType {
    kind: 'TLBHashmapType';
    key: TLBMathExpr;
    value: TLBFieldType;
    directStore?: boolean;
}

export interface TLBCondType {
    kind: 'TLBCondType';
    condition: TLBMathExpr;
    value: TLBFieldType;
}

export interface TLBTupleType {
    kind: 'TLBTupleType';
    times: TLBMathExpr;
    value: TLBFieldType;
}

export type TLBFieldType =
    | TLBNumberType
    | TLBBitsType
    | TLBNamedType
    | TLBRefType
    | TLBExprMathType
    | TLBVarIntegerType
    | TLBAddressType
    | TLBCellType
    | TLBBoolType
    | TLBConditionalType
    | TLBMultipleType
    | TLBCoinsType
    | TLBCellInsideType
    | TLBHashmapType
    | TLBCondType
    | TLBTupleType;

// Field definition
export interface TLBField {
    name: string | undefined;
    fieldType: TLBFieldType;
    subFields: TLBField[];
    implicit?: boolean;
}

// Variable (constructor parameter)
export interface TLBVariable {
    name: string;
    type: '#' | 'Type';
    negated: boolean;
    isConst?: boolean;
    constValue?: number;
    deriveExpr?: TLBMathExpr;
    isField?: boolean;
}

// Parameter with variable info
export interface TLBParameter {
    variable: TLBVariable;
    paramExpr?: TLBMathExpr;
    argName?: string;
}

// Constructor definition
export interface TLBConstructor {
    name: string;
    tag: TLBConstructorTag;
    fields: TLBField[];
    constraints: TLBMathExpr[];
    declaration: string;
    parameters: TLBParameter[];
    parametersMap: Map<string, TLBParameter>;
    variables: TLBVariable[];
    variablesMap: Map<string, TLBVariable>;
    tlbType: string;
    resultParameters?: TLBMathExpr[];
}

// Type definition (contains multiple constructors)
export interface TLBType {
    name: string;
    constructors: TLBConstructor[];
}

// Helper type alias for math expression input (same as TLBMathExpr)
export type MathExprInput = TLBMathExpr;
