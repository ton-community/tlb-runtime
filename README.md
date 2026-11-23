# TL-B Runtime

TL‑B Runtime is a library for parsing and (de)serializing data according to [TL‑B schemas](https://docs.ton.org/v3/documentation/data-formats/tlb/tl-b-language), enabling programmatic work with binary structures and [Cell & Bag of Cells (BoC)](https://docs.ton.org/v3/documentation/data-formats/tlb/cell-boc)

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
import { parseTLB } from '@ton-community/tlb-runtime';

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

1. Bump `version` in `package.json` and merge the PR into `main`. The [release workflow](.github/workflows/release.yaml) builds the npm tarball and runs a publish dry run on the PR.
2. Tag the **merged version-bump commit** and push just that tag. For example, for `1.0.0-alpha.4`:

   ```bash
   git fetch origin main
   git tag v1.0.0-alpha.4 <merged-commit-sha>
   git push origin refs/tags/v1.0.0-alpha.4
   ```

3. Follow the [Release workflow run](https://github.com/ton-community/tlb-runtime/actions/workflows/release.yaml). It checks that the tag is exactly `v` plus the package version and the commit is on `main`, builds the package, runs the signed-integer regression test, publishes to npm, then creates a GitHub Release with generated notes.

Stable versions publish to `latest`; numbered prereleases such as `1.0.0-alpha.4` publish to `alpha` and are marked as prereleases on GitHub. If npm's `latest` already points to an earlier prerelease in that same series (e.g. `1.0.0-alpha.3`), it advances too.

**npm access:** The workflow uses [trusted publishing](https://docs.npmjs.com/trusted-publishers/) for `ton-community/tlb-runtime`, workflow `release.yaml`, without a GitHub environment. Enable `npm publish` and `npm dist-tag` in the package's Trusted Publisher settings. If authorization fails, fix the npm settings and choose **Re-run failed jobs** in Actions. This also lets you retry the final step after a successful npm publish without publishing the version twice.
