# TL-B Runtime

## Quick Start

```bash
npm install @ton-community/tlb-runtime
```

## Usage

### Simple

```typescript
import { parseTLB } from '@ton-community/tlb-runtime';

interface Data {
  kind: 'Foo';
  x: number;
}

// language=tlb
const runtime = parseTLB<Data>('_ x:# = Foo;')

const pack = runtime.serialize({
  kind: 'Foo',
  x: 73,
})
if (pack.success) {
  console.log({ pack: pack.value.endCell().toBoc().toString('base64')});
} else {
  console.error(pack.error.message);
}
// { pack: 'te6cckEBAQEABgAACAAAAEmTxmY2' }

const unpack = runtime.deserialize('te6cckEBAQEABgAACAAAACoFpvBE')
if (unpack.success) {
  console.log({ unpack: unpack.value});
} else {
  console.error(unpack.error.message);
}
// { unpack: { kind: 'Foo', x: 42 } }
```

## TEP-74 Fungible tokens (Jettons)

```typescript
import { parseTLB } from 'tlb-rest-server/src/tlb-runtime';

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
 = InternalMsgBody;`

const runtime = parseTLB(schema)
const pack = runtime.serialize({
  kind: 'InternalMsgBody',
  query_id: 0,
  amount: 1n,
  response_destination: 'Ef8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAU',
  custom_payload: { kind: 'Maybe_nothing' }
})
if (pack.success) {
  console.log(pack.value.endCell().toBoc().toString('base64'));
} else {
  console.error(pack.error.message);
}
// te6cckEBAQEAMQAAXllfB7wAAAAAAAAAABAZ/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8gPSJw==

const unpack = runtime.deserialize('te6cckEBAQEAMQAAXllfB7wAAAAAAAAAABKp/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4/EP1Q==')
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

```bash
yarn install --frozen-lockfile && yarn build && npm publish --tag=alpha --try-run
```
