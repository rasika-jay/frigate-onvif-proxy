const os = require('os');
const { getIp4FromMac, generateUUIDv4, generateNetworkMac } = require('../src/net-tools');

jest.mock('os');

const logger = { debug: jest.fn(), error: jest.fn() };

beforeEach(() => jest.clearAllMocks());

describe('generateUUIDv4', () => {
    test('returns valid UUID v4 format', () => {
        expect(generateUUIDv4()).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );
    });

    test('returns unique values', () => {
        expect(generateUUIDv4()).not.toBe(generateUUIDv4());
    });
});

describe('generateNetworkMac', () => {
    test('returns valid colon-separated MAC format', () => {
        expect(generateNetworkMac()).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
    });

    test('uses LAA unicast prefix 1A:11:B0', () => {
        expect(generateNetworkMac().startsWith('1A:11:B0:')).toBe(true);
    });

    test('returns unique values', () => {
        expect(generateNetworkMac()).not.toBe(generateNetworkMac());
    });
});

describe('getIp4FromMac', () => {
    test('returns the IPv4 address when MAC matches (case-insensitive)', () => {
        os.networkInterfaces.mockReturnValue({
            eth0: [{ family: 'IPv4', mac: '1a:11:b0:aa:bb:cc', address: '192.168.1.10' }]
        });
        expect(getIp4FromMac(logger, '1A:11:B0:AA:BB:CC')).toBe('192.168.1.10');
    });

    test('returns null when MAC is not found', () => {
        os.networkInterfaces.mockReturnValue({
            eth0: [{ family: 'IPv4', mac: '00:11:22:33:44:55', address: '192.168.1.1' }]
        });
        expect(getIp4FromMac(logger, '1A:11:B0:AA:BB:CC')).toBeNull();
    });

    test('skips IPv6 interfaces even if MAC matches', () => {
        os.networkInterfaces.mockReturnValue({
            eth0: [{ family: 'IPv6', mac: '1a:11:b0:aa:bb:cc', address: 'fe80::1' }]
        });
        expect(getIp4FromMac(logger, '1a:11:b0:aa:bb:cc')).toBeNull();
    });

    test('searches across multiple interfaces', () => {
        os.networkInterfaces.mockReturnValue({
            lo:   [{ family: 'IPv4', mac: '00:00:00:00:00:00', address: '127.0.0.1' }],
            eth0: [{ family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', address: '10.0.0.1' }],
            eth1: [{ family: 'IPv4', mac: '1a:11:b0:aa:bb:cc', address: '172.16.0.5' }]
        });
        expect(getIp4FromMac(logger, '1a:11:b0:aa:bb:cc')).toBe('172.16.0.5');
    });
});
