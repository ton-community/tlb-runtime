// Interpreter to evaluate TLBMathExpr at runtime
import { TLBMathExpr } from './types';

export function safeExpressionNumber(result: bigint | number): number {
    const value = Number(result);
    if (!Number.isSafeInteger(value)) throw new Error('Expression result exceeds the safe integer range');
    return value;
}

export class MathExprEvaluator {
    private variables: ReadonlyMap<string, number | bigint>;

    constructor(variables: ReadonlyMap<string, number | bigint> = new Map()) {
        this.variables = variables;
    }

    static calculateBitsForLessThan(n: number): number {
        if (n <= 0) return 0;
        if (n === 1) return 0;
        const maxValue = n - 1;
        if (maxValue === 0) return 0;
        return Math.ceil(Math.log2(maxValue + 1));
    }

    static calculateBitsForLessThanOrEqual(n: number): number {
        if (n < 0) return 0;
        if (n === 0) return 0;
        return Math.ceil(Math.log2(n + 1));
    }

    evaluate(expr: TLBMathExpr): number {
        const result = this.evaluateInteger(expr);
        return safeExpressionNumber(result);
    }

    private evaluateInteger(expr: TLBMathExpr): bigint {
        if (expr.kind === 'TLBNumberExpr') {
            return BigInt(expr.n);
        }

        if (expr.kind === 'TLBVarExpr') {
            const value = this.variables.get(expr.x);
            if (value === undefined) {
                throw new Error(`Variable ${expr.x} is not defined`);
            }
            return BigInt(value);
        }

        if (expr.kind === 'TLBBinaryOp') {
            const left = this.evaluateInteger(expr.left);
            const right = this.evaluateInteger(expr.right);
            switch (expr.operation) {
                case '+':
                    return left + right;
                case '-':
                    return left - right;
                case '*':
                    return left * right;
                case '/':
                    return left / right - (left % right !== 0n && left < 0n !== right < 0n ? 1n : 0n);
                case '%':
                    return left % right;
                case '<<':
                    return left << right;
                case '.':
                    return (left >> right) & 1n;
                case '>>':
                    return left >> right;
                case '&':
                    return left & right;
                case '|':
                    return left | right;
                case '^':
                    return left ^ right;
                case '==':
                    return left === right ? 1n : 0n;
                case '!=':
                    return left !== right ? 1n : 0n;
                case '<':
                    return left < right ? 1n : 0n;
                case '<=':
                    return left <= right ? 1n : 0n;
                case '>':
                    return left > right ? 1n : 0n;
                case '>=':
                    return left >= right ? 1n : 0n;
                case '=':
                    return left === right ? 1n : 0n;
            }
        }

        if (expr.kind === 'TLBUnaryOp') {
            const operation = expr.operation;
            switch (operation) {
                case '.': {
                    const value = this.evaluateInteger(expr.value);
                    return value > 0n ? BigInt(value.toString(2).length) : 0n;
                }
                case '-':
                    return -this.evaluateInteger(expr.value);
                case '~':
                    // In TL-B, ~n means 'inferred/computed value of n'.
                    // Always return the inner value directly.
                    return this.evaluateInteger(expr.value);
                case '!':
                    return this.evaluateInteger(expr.value) ? 0n : 1n;
                default:
                    throw new Error(`Unknown unary operation: ${operation}`);
            }
        }

        throw new Error(`Unsupported expression type: ${typeof expr}`);
    }
}
