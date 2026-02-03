export class TLBRuntimeError extends Error {
    public readonly details?: unknown;
    constructor(message: string, details?: unknown) {
        super(message);
        this.name = 'TLBRuntimeError';
        this.details = details;
    }
}

export class TLBSchemaError extends TLBRuntimeError {}

export class TLBDataError extends TLBRuntimeError {}
