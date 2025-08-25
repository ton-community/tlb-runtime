export interface Success<T> {
    readonly success: true;
    readonly value: T;
}

export interface Failure<E = Error> {
    readonly success: false;
    readonly error: E;
}

export type Result<T, E = Error> = Success<T> | Failure<E>;

export function error<E = Error>(result: E): Error {
    return result instanceof Error ? result : new Error(String(result));
}

export function unwrap<T, E = Error>(result: Result<T, E>): T {
    if (result.success) {
        return result.value;
    }
    throw error(result.error);
}
