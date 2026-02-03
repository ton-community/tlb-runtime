export class SymbolMap {
    static NotExist = 0;
    private map: Map<string, number> = new Map();
    private counter: number = 0;

    getName(typeNameId: number): string | undefined {
        for (const [name, id] of this.map.entries()) {
            if (id === typeNameId) {
                return name;
            }
        }
        return undefined;
    }

    lookupAdd(name: string): number {
        if (this.map.has(name)) {
            return this.lookup(name);
        }
        this.counter += 1;
        this.map.set(name, this.counter);
        return this.counter;
    }

    lookup(name: string): number {
        return this.map.get(name) || SymbolMap.NotExist;
    }
}

export const symbolMap = new SymbolMap();
