import { TLBMathExpr, TLBNumberExpr, TLBVarExpr, TLBBinaryOp, TLBUnaryOp } from '@ton-community/tlb-codegen';

// Interpreter to evaluate TLBMathExpr at runtime
export class MathExprEvaluator {
    private variables: Map<string, number>;

    constructor(variables: Map<string, number> = new Map()) {
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
        if (expr instanceof TLBNumberExpr) {
            return expr.n;
        }

        if (expr instanceof TLBVarExpr) {
            const value = this.variables.get(expr.x);
            if (value === undefined) {
                throw new Error(`Variable ${expr.x} is not defined`);
            }
            return value;
        }

        if (expr instanceof TLBBinaryOp) {
            const left = this.evaluate(expr.left);
            const right = this.evaluate(expr.right);
            switch (expr.operation) {
                case '+':
                    return left + right;
                case '-':
                    return left - right;
                case '*':
                    return left * right;
                case '/':
                    return Math.floor(left / right);
                case '%':
                    return left % right;
                case '<<':
                    return left << right;
                case '>>':
                    return left >> right;
                case '&':
                    return left & right;
                case '|':
                    return left | right;
                case '^':
                    return left ^ right;
                case '==':
                    return left === right ? 1 : 0;
                case '!=':
                    return left !== right ? 1 : 0;
                case '<':
                    return left < right ? 1 : 0;
                case '<=':
                    return left <= right ? 1 : 0;
                case '>':
                    return left > right ? 1 : 0;
                case '>=':
                    return left >= right ? 1 : 0;
                case '=':
                    return left === right ? 1 : 0;
                default:
                    throw new Error(`Unknown operation: ${expr.operation}`);
            }
        }

        if (expr instanceof TLBUnaryOp) {
            const operation = expr.operation;
            switch (operation) {
                case '.': {
                    const innerExpr = expr.value;
                    if (innerExpr instanceof TLBBinaryOp && innerExpr.operation === '-') {
                        const left = this.evaluate(innerExpr.left);
                        const right = this.evaluate(innerExpr.right);
                        if (right === 1) {
                            return MathExprEvaluator.calculateBitsForLessThan(left);
                        }
                        return left - right;
                    }
                    if (innerExpr instanceof TLBNumberExpr) {
                        return MathExprEvaluator.calculateBitsForLessThanOrEqual(innerExpr.n);
                    }
                    return this.evaluate(innerExpr);
                }

                case '-':
                    return -this.evaluate(expr.value);
                case '~':
                    return ~this.evaluate(expr.value);
                case '!':
                    return this.evaluate(expr.value) ? 0 : 1;
                default:
                    throw new Error(`Unknown unary operation: ${operation}`);
            }
        }

        throw new Error(`Unsupported expression type: ${typeof expr}`);
    }
}
