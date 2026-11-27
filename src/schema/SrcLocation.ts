export interface SrcLocationProp {
    line: number;
    column: number;
    file: string;
}

export class SrcLocation {
    line: number;
    column: number;
    file: string;

    constructor(prop: Partial<SrcLocationProp>) {
        this.line = prop.line ?? 0;
        this.column = prop.column ?? 0;
        this.file = prop.file ?? '';
    }

    static from(prop: Partial<SrcLocationProp> | null | undefined): SrcLocation {
        if (prop && 'line' in prop && 'column' in prop) {
            return new SrcLocation(prop);
        }
        return new SrcLocation({});
    }
}
