import * as tlb from 'tlb-parser-v2';

import { crc32 } from '../utils';

function fields(items: tlb.FieldDefinition[]): string {
    return items
        .map((field) => {
            const prefix = 'name' in field && field.name ? field.name + ':' : '';
            if (field instanceof tlb.FieldBuiltinDef) return prefix + field.type;
            if (field instanceof tlb.FieldAnonymousDef) return prefix + group(field);
            return prefix + expression(field.expr);
        })
        .join(' ');
}

function group(field: tlb.FieldAnonExpr | tlb.FieldAnonymousDef): string {
    return (field.isRef ? '^' : '') + '[ ' + fields(field.fields) + ' ]';
}

function expression(e: tlb.Expression): string {
    if (e instanceof tlb.CompareExpr) {
        if (e.op === '>=') {
            return ['<=', expression(e.right), expression(e.left)].join(' ');
        }
        return [e.op, expression(e.left), expression(e.right)].join(' ');
    }
    if (e instanceof tlb.MathExpr) {
        if (e.op === '*' && e.right instanceof tlb.NumberExpr) {
            if (e.left instanceof tlb.NumberExpr) return String(e.left.num * e.right.num);
            return e.right.num + ' * ' + expression(e.left);
        }
        return expression(e.left) + ' ' + e.op + ' ' + expression(e.right);
    }
    if (e instanceof tlb.NameExpr || e instanceof tlb.BuiltinZeroArgs) return e.name;
    if (e instanceof tlb.NumberExpr) return String(e.num);
    if (e instanceof tlb.CellRefExpr || e instanceof tlb.NegateExpr)
        return (e instanceof tlb.CellRefExpr ? '^' : '~') + expression(e.expr);
    if (e instanceof tlb.BuiltinOneArgExpr) return e.name + ' ' + expression(e.arg);
    if (e instanceof tlb.CombinatorExpr) return [e.name, ...e.args.map(expression)].join(' ');
    if (e instanceof tlb.FieldAnonExpr) return group(e);
    if (e instanceof tlb.CondExpr)
        return expression(e.left) + (e.dotExpr === null ? '' : '.' + e.dotExpr) + '?' + expression(e.condExpr);
    throw new Error('Unsupported expression in an implicit constructor tag');
}

export function constructorTag(d: tlb.Declaration): number {
    return crc32(
        [d.constructorDef.name, fields(d.fields), '=', d.combinator.name, ...d.combinator.args.map(expression)]
            .filter(Boolean)
            .join(' '),
    );
}
