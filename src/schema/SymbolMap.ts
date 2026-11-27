export class SymbolMap {
    private readonly ids = new Map<string, number>();
    private readonly names: string[] = [];

    getName(id: number): string | undefined {
        return this.names[id - 1];
    }

    lookupAdd(name: string): number {
        const existing = this.ids.get(name);
        if (existing !== undefined) return existing;
        const id = this.names.push(name);
        this.ids.set(name, id);
        return id;
    }

    lookup(name: string): number {
        return this.ids.get(name) ?? 0;
    }
}
