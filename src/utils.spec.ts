import { crc32 } from '.';

describe('utils', () => {
    test('crc32', () => {
        expect(crc32('r = T').toString(16)).toBe('30332c00');
    });
});
