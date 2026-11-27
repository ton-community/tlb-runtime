import { beginCell } from '@ton/core';

import { parseTLB, unwrap } from './index';

describe('legacy public API', () => {
    const schema = '_ value:int32 = Signed;';
    it('round-trips every field in a TON Connect OffchainOrder', () => {
        const orderSchema = [
            'offchain_order$_ salt:uint32 market_id:uint32',
            'maker_amount:(VarUInteger 16) taker_amount:(VarUInteger 16)',
            'is_buy:Bool is_yes:Bool creator_pub_key:uint256 = OffchainOrder;',
        ].join(' ');
        const order = beginCell()
            .storeUint(1, 32)
            .storeUint(2, 32)
            .storeCoins(60000000n)
            .storeCoins(100000000n)
            .storeBit(true)
            .storeBit(false)
            .storeUint(123n, 256)
            .endCell();
        const runtime = unwrap(parseTLB(schema).changeSchema(orderSchema));
        const value = runtime.parseCell(order);
        expect(value).toEqual({
            kind: 'OffchainOrder',
            salt: 1,
            market_id: 2,
            maker_amount: 60000000n,
            taker_amount: 100000000n,
            is_buy: true,
            is_yes: false,
            creator_pub_key: 123n,
        });
        expect(runtime.encodeCell(value).equals(order)).toBe(true);
    });
});
