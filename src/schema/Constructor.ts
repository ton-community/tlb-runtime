import { BitPrefixCollection } from './BitPrefixCollection';
import { AdmissibilityInfo } from './AdmissibilityInfo';
import { Field } from './Field';
import { Size } from './Size';
import { TypeExpr, TypeExprType } from './TypeExpr';
import { SrcLocation } from './SrcLocation';
import type { Type } from './Type';
import { symbolMap } from './SymbolMap';

export interface ConstructorProp {
    constrName: number;
    typeName: number;
    typeDefined: Type | null;
    where: SrcLocation;
    tag: bigint;
    tagBits: number;
    fieldsNum: number;
    typeArity: number;
    isFwd: boolean;
    isEnum: boolean;
    isSimpleEnum: boolean;
    isSpecial: boolean;
    hasFixedSize: boolean;
    anyBits: boolean;
    size: Size;
    beginsWith: BitPrefixCollection;
    fields: Field[];
    params: TypeExpr[];
    paramNegated: boolean[];
    paramConstVal: number[];
    admissibleParams: AdmissibilityInfo;
}

export class Constructor {
    constrName: number;
    typeName: number;
    typeDefined: Type | null;
    where: SrcLocation;
    tag: bigint;
    tagBits: number;
    fieldsNum: number;
    typeArity: number;
    isFwd: boolean;
    isEnum: boolean;
    isSimpleEnum: boolean;
    isSpecial: boolean;
    hasFixedSize: boolean;
    anyBits: boolean;
    size: Size;
    beginsWith: BitPrefixCollection;
    fields: Field[];
    params: TypeExpr[];
    paramNegated: boolean[];
    paramConstVal: number[];
    admissibleParams: AdmissibilityInfo;

    constructor(init: Partial<ConstructorProp>) {
        this.constrName = init.constrName ?? 0;
        this.typeName = init.typeName ?? 0;
        this.typeDefined = init.typeDefined ?? null;
        this.where = init.where ?? { line: 0, column: 0, file: '' };
        this.tag = init.tag ?? 0n;
        this.tagBits = init.tagBits ?? 0;
        this.fieldsNum = init.fieldsNum ?? 0;
        this.typeArity = init.typeArity ?? 0;
        this.isFwd = init.isFwd ?? false;
        this.isEnum = init.isEnum ?? false;
        this.isSimpleEnum = init.isSimpleEnum ?? false;
        this.isSpecial = init.isSpecial ?? false;
        this.hasFixedSize = init.hasFixedSize ?? false;
        this.anyBits = init.anyBits ?? false;
        this.size = init.size ?? new Size(Size.Impossible);
        this.beginsWith = init.beginsWith ?? new BitPrefixCollection();
        this.fields = init.fields ?? [];
        this.params = init.params ?? [];
        this.paramNegated = init.paramNegated ?? [];
        this.paramConstVal = init.paramConstVal ?? [];
        this.admissibleParams = init.admissibleParams ?? new AdmissibilityInfo();
    }

    /**
     * Get the display name of the constructor with tag representation.
     * E.g., "bool_false$0" or "unit$_"
     */
    get displayName(): string {
        const constrName = symbolMap.getName(this.constrName) || '_';

        if (this.tagBits > 0) {
            let tagStr = '';
            if (this.tagBits <= 64) {
                tagStr = this.tag.toString(2).padStart(this.tagBits, '0');
            } else {
                tagStr = '?';
            }
            return constrName === '_' ? `_$${tagStr}` : `${constrName}$${tagStr}`;
        }

        if (this.isSimpleEnum || (this.tagBits === 0 && this.fields.length === 0)) {
            return constrName === '_' ? '_$_' : `${constrName}$_`;
        }

        if (this.tagBits === 0 && this.fields.length > 0) {
            return constrName === '_' ? '_$_' : `${constrName}$_`;
        }

        return constrName;
    }

    /**
     * Format a field for display in the constructor declaration.
     * Handles implicit fields, anonymous fields, and parentheses.
     */
    private formatFieldForDeclaration(field: Field): string {
        const fieldName = symbolMap.getName(field.name);
        let fieldStr = '';

        if (fieldName) {
            // Use toDeclarationString with fields array for original names
            let typeStr = field.type.toDeclarationString(this.fields);
            // Add parens for complex types with arguments (Apply, MulConst/Tuple)
            const needsParens =
                (field.type.tp === TypeExprType.Apply && field.type.args.length > 0) ||
                (field.type.tp === TypeExprType.MulConst && field.type.args.length > 0) ||
                (field.type.tp === TypeExprType.Tuple && field.type.args.length > 0);
            if (needsParens) {
                typeStr = `(${typeStr})`;
            }
            fieldStr = `${fieldName}:${typeStr}`;
        } else {
            // Anonymous field, just print type
            let typeStr = field.type.toDeclarationString(this.fields);
            if (
                !field.implicit &&
                field.type.tp !== TypeExprType.IntConst &&
                field.type.tp !== TypeExprType.Type &&
                field.type.tp !== TypeExprType.Param
            ) {
                if (field.type.args.length > 0) {
                    typeStr = `(${typeStr})`;
                }
            }
            fieldStr = typeStr;
        }

        // Wrap implicit fields in curly braces
        return field.implicit ? `{${fieldStr}}` : fieldStr;
    }

    /**
     * Get the result type string with parameters.
     * E.g., "Unary (~n + 1)" or "Maybe X"
     */
    get resultType(): string {
        const typeName = this.typeDefined
            ? symbolMap.getName(this.typeDefined.typeNameId) || `type#${this.typeDefined.typeNameId}`
            : symbolMap.getName(this.typeName) || `type#${this.typeName}`;

        let result = typeName;

        if (this.typeDefined && this.typeDefined.arity > 0) {
            if (this.params.length > 0) {
                // Use toDeclarationString with fields array for original names
                const paramStrs = this.params.map((p) => {
                    const str = p.toDeclarationString(this.fields);
                    // Wrap complex expressions (Add, Mul) in parentheses
                    if (p.tp === TypeExprType.Add || p.tp === TypeExprType.MulConst) {
                        return `(${str})`;
                    }
                    return str;
                });
                result += ' ' + paramStrs.join(' ');
            } else {
                // Fallback: collect implicit field names as type parameters
                const typeParams: string[] = [];
                for (const field of this.fields) {
                    if (field.implicit && field.type.typeApplied?.name === 'Type') {
                        const paramName = symbolMap.getName(field.name);
                        if (paramName) {
                            typeParams.push(paramName);
                        }
                    }
                }
                if (typeParams.length > 0) {
                    result += ' ' + typeParams.join(' ');
                }
            }
        }

        return result;
    }

    /**
     * Get the constructor declaration string.
     * E.g., "bool_false$0 = Bool"
     */
    get declaration(): string {
        const parts: string[] = [this.displayName];

        for (const field of this.fields) {
            parts.push(this.formatFieldForDeclaration(field));
        }

        parts.push(`= ${this.resultType}`);
        return parts.join(' ');
    }

    /**
     * Get size display string with flags.
     */
    get sizeDisplay(): string {
        const sizeStr = this.size.toString();
        const parts: string[] = [`size ${sizeStr}`];

        if (this.hasFixedSize) {
            parts.push('(fixed)');
        }
        if (this.hasFixedSize && this.anyBits) {
            parts.push('(any bits)');
        }

        return parts.join(' ');
    }

    toString(): string {
        const out: string[] = [];
        const constrName = symbolMap.getName(this.constrName) || '_';

        out.push(`  constructor \`${constrName}\``);
        out.push(`\t${this.declaration};`);
        out.push(`\tbegins with ${this.beginsWith.toString()}`);

        // Output admissibility info if typeArity > 0, not all-set, and not none-set
        if (this.typeArity > 0 && !this.admissibleParams.isSetAll() && !this.admissibleParams.isNoneSet()) {
            out.push(`\tadmissibility ${this.admissibleParams.toString()}`);
        }

        out.push(`\t${this.sizeDisplay}`);

        // Output fields
        for (const field of this.fields) {
            out.push(`\t\t${field.toString()}`);
        }

        return out.join('\n');
    }
}
