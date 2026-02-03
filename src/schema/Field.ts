import { TypeExpr } from './TypeExpr';
import { SrcLocation } from './SrcLocation';
import { symbolMap } from './SymbolMap';

export class Field {
    /** Field index */
    fieldIdx: number;

    /** Whether it is an implicit parameter */
    implicit: boolean;

    /** Whether the value is known */
    known: boolean;

    /** Whether it is a constraint */
    constraint: boolean;

    /** Whether the field is used */
    used: boolean;

    /** Whether it is a subrecord */
    subrec: boolean;

    /** Field name (symbol index, 0 if unnamed) */
    name: number;

    /** Field type */
    type: TypeExpr;

    /** Source code location */
    loc: SrcLocation;

    constructor(
        fieldIdx: number,
        name: number,
        type: TypeExpr,
        loc: SrcLocation,
        {
            implicit = false,
            known = false,
            constraint = false,
            used = false,
            subrec = false,
        }: {
            implicit?: boolean;
            known?: boolean;
            constraint?: boolean;
            used?: boolean;
            subrec?: boolean;
        } = {},
    ) {
        this.fieldIdx = fieldIdx;
        this.name = name;
        this.type = type;
        this.loc = loc;
        this.implicit = implicit;
        this.known = known;
        this.constraint = constraint;
        this.used = used;
        this.subrec = subrec;
    }

    toString() {
        const fieldName = this.name === 0 ? '_' : symbolMap.getName(this.name) || `field#${this.name}`;
        const fieldParts: string[] = [];
        fieldParts.push(`field \`${fieldName}\`:`);
        fieldParts.push(this.type.toString());
        // Convert boolean used to number for display
        fieldParts.push(`(used=${this.used ? 1 : 0})`);
        fieldParts.push(`(is_nat_subtype=${this.type.isNatSubtype ? 1 : 0})`);
        return fieldParts.join(' ');
    }
}
