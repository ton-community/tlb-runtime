# TL-B Runtime

TL‑B Runtime is a library for parsing and (de)serializing data according to [TL‑B schemas](https://docs.ton.org/v3/documentation/data-formats/tlb/tl-b-language), enabling programmatic work with binary structures and [Cell & Bag of Cells (BoC)](https://docs.ton.org/v3/documentation/data-formats/tlb/cell-boc)

## Quick Start

```bash
npm install @ton-community/tlb-runtime
```

## Usage

For new code, use `runtimeBy(schema)` and `decodeCell(schema, cell)` or `runtime.decodeCell(cell)`. The deprecated schema factory `parseTLB` uses the previous schema compiler to preserve its built-in types and normalized field names. A runtime created this way keeps that compiler when its schema changes. The previous names `parseTLB`, `parseCell` and `runtime.parseCell` remain available with deprecation annotations. Use `TypedCell` for decoded records and `DecodedCell` for field values in place of the deprecated `ParsedCell` type.

With `autoText` enabled (the default), `bits` fields with a whole number of bytes decode as strings when their bytes form valid UTF-8 text. Tabs and line breaks are allowed. Invalid UTF-8 and other control characters keep the value as a `BitString`, preserving the original bytes for encoding.

### Simple

```typescript
import { runtimeBy } from '@ton-community/tlb-runtime';

interface Data {
    kind: 'Foo';
    x: number;
}

// language=tlb
const runtime = runtimeBy<Data>('_ x:# = Foo;');

const pack = runtime.serialize({
    kind: 'Foo',
    x: 73,
});
if (pack.success) {
    console.log({ pack: pack.value.endCell().toBoc().toString('base64') });
} else {
    console.error(pack.error.message);
}
// { pack: 'te6cckEBAQEABgAACAAAAEmTxmY2' }

const unpack = runtime.deserialize('te6cckEBAQEABgAACAAAACoFpvBE');
if (unpack.success) {
    console.log({ unpack: unpack.value });
} else {
    console.error(unpack.error.message);
}
// { unpack: { kind: 'Foo', x: 42 } }
```

## TEP-74 Fungible tokens (Jettons)

```typescript
import { runtimeBy } from '@ton-community/tlb-runtime';

// language=tlb
const schema = `nothing$0 {X:Type} = Maybe X;
just$1 {X:Type} value:X = Maybe X;
var_uint$_ {n:#} len:(#< n) value:(uint (len * 8)) = VarUInteger n;
addr_none$00 = MsgAddressExt;
addr_extern$01 len:(## 9) external_address:(bits len) = MsgAddressExt;
anycast_info$_ depth:(#<= 30) { depth >= 1 } rewrite_pfx:(bits depth) = Anycast;
addr_std$10 anycast:(Maybe Anycast) workchain_id:int8 address:bits256  = MsgAddressInt;
addr_var$11 anycast:(Maybe Anycast) addr_len:(## 9) workchain_id:int32 address:(bits addr_len) = MsgAddressInt;
_ _:MsgAddressInt = MsgAddress;
_ _:MsgAddressExt = MsgAddress;
burn#595f07bc
 query_id:uint64
 amount:(VarUInteger 16)
 response_destination:MsgAddress
 custom_payload:(Maybe ^Cell)
 = InternalMsgBody;`;

const runtime = runtimeBy(schema);
const pack = runtime.serialize({
    kind: 'InternalMsgBody',
    query_id: 0,
    amount: 1n,
    response_destination: 'Ef8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAU',
    custom_payload: { kind: 'Maybe_nothing' },
});
if (pack.success) {
    console.log(pack.value.endCell().toBoc().toString('base64'));
} else {
    console.error(pack.error.message);
}
// te6cckEBAQEAMQAAXllfB7wAAAAAAAAAABAZ/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8gPSJw==

const unpack = runtime.deserialize(
    'te6cckEBAQEAMQAAXllfB7wAAAAAAAAAABKp/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4/EP1Q==',
);
if (unpack.success) {
    console.log(unpack.value);
} else {
    console.error(unpack.error.message);
}
// { kind: 'InternalMsgBody', query_id: 0n, amount: 42n, response_destination: Ef8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAU, custom_payload: { kind: 'Maybe_nothing' } }
```

## Development

```bash
yarn install
yarn build
yarn test
yarn lint
yarn lint:fix
```

## Release

Merge the version change into `master`, then tag the merged commit with `v` followed by the version from `package.json`.

```bash
git fetch origin master
git tag v1.0.0-alpha.5 <merged-commit-sha>
git push origin refs/tags/v1.0.0-alpha.5
```

The [publish workflow](.github/workflows/deploy.yml) checks the tag against the package version, builds the package, publishes it to npm with the `latest` dist-tag, and creates a GitHub Release. It uses npm trusted publishing from the `deploy` environment.

## Parser source

The runtime uses the npm release of [@ton-community/tlb-parser](https://www.npmjs.com/package/@ton-community/tlb-parser). The dependency name `tlb-parser-v2` distinguishes the 0.2.x parser from the 0.1.x parser required by `tlb-codegen` for the deprecated API.

Unnamed reference groups such as `^[ a:uint8 ]` expose their fields on the
parent object. Each decoded key must be unique within a constructor, including
automatically assigned keys such as `anon1`. The schema compiler reports both
field paths when flattening groups would overwrite a value.
