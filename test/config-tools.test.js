const { deepMerge, validateConfig } = require('../src/config-tools');

describe('deepMerge', () => {
    test('base values survive when override adds nothing', () => {
        expect(deepMerge({ a: 1 }, {})).toEqual({ a: 1 });
    });

    test('override scalar wins over base scalar', () => {
        expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
    });

    test('override adds new keys', () => {
        expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    });

    test('nested objects are merged recursively', () => {
        expect(deepMerge(
            { a: { x: 1, y: 2 } },
            { a: { y: 3 } }
        )).toEqual({ a: { x: 1, y: 3 } });
    });

    test('arrays replace entirely — no concatenation', () => {
        expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
    });

    test('null override replaces object in base', () => {
        expect(deepMerge({ a: { x: 1 } }, { a: null })).toEqual({ a: null });
    });

    test('does not mutate the base object', () => {
        const base = { a: { x: 1 } };
        deepMerge(base, { a: { x: 2 } });
        expect(base.a.x).toBe(1);
    });

    test('global frigate.mqtt merges with per-camera frigate.camera', () => {
        const global = { dev: 'eth0', frigate: { mqtt: { host: '127.0.0.1', port: 1883 } } };
        const camera = { name: 'Garden', frigate: { camera: 'garden' } };
        const result = deepMerge(global, camera);
        expect(result.dev).toBe('eth0');
        expect(result.frigate.mqtt.host).toBe('127.0.0.1');
        expect(result.frigate.camera).toBe('garden');
    });

    test('per-camera objects list replaces global objects list', () => {
        const global = { frigate: { objects: ['person', 'cat'] } };
        const camera = { frigate: { objects: ['car'] } };
        expect(deepMerge(global, camera).frigate.objects).toEqual(['car']);
    });
});

describe('validateConfig', () => {
    const logger = { error: jest.fn() };
    beforeEach(() => logger.error.mockClear());

    function validCamera(overrides = {}) {
        return {
            name: 'TestCam',
            dev: 'eth0',
            ports: { server: 58081 },
            target: { hostname: '192.168.1.1' },
            highQuality: {
                width: 1920, height: 1080, framerate: 15,
                bitrate: 4000, quality: 4, rtsp: '/stream1'
            },
            ...overrides
        };
    }

    test('accepts a valid single-camera config', () => {
        expect(validateConfig(logger, { onvif: [validCamera()] })).toBe(true);
        expect(logger.error).not.toHaveBeenCalled();
    });

    test('rejects when onvif key is missing', () => {
        expect(validateConfig(logger, {})).toBe(false);
    });

    test('rejects empty onvif array', () => {
        expect(validateConfig(logger, { onvif: [] })).toBe(false);
    });

    test('rejects camera missing "name"', () => {
        expect(validateConfig(logger, { onvif: [validCamera({ name: undefined })] })).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"name"'));
    });

    test('rejects camera missing "dev"', () => {
        expect(validateConfig(logger, { onvif: [validCamera({ dev: undefined })] })).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"dev"'));
    });

    test('rejects camera missing "ports.server"', () => {
        expect(validateConfig(logger, { onvif: [validCamera({ ports: {} })] })).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ports.server'));
    });

    test('rejects camera with neither target.hostname nor target.rtsp_url', () => {
        expect(validateConfig(logger, { onvif: [validCamera({ target: {} })] })).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('target.hostname'));
    });

    test('accepts camera with target.rtsp_url instead of hostname', () => {
        const cam = validCamera({ target: { rtsp_url: 'rtsp://192.168.1.1:8554/stream' } });
        expect(validateConfig(logger, { onvif: [cam] })).toBe(true);
    });

    test('rejects frigate.mqtt without frigate.camera', () => {
        const cam = validCamera({ frigate: { mqtt: { host: '127.0.0.1' } } });
        expect(validateConfig(logger, { onvif: [cam] })).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"frigate.camera"'));
    });

    test('accepts frigate.mqtt when frigate.camera is also set', () => {
        const cam = validCamera({ frigate: { mqtt: { host: '127.0.0.1' }, camera: 'garden' } });
        expect(validateConfig(logger, { onvif: [cam] })).toBe(true);
    });

    test('rejects camera missing highQuality section', () => {
        expect(validateConfig(logger, { onvif: [validCamera({ highQuality: undefined })] })).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('highQuality'));
    });

    test('rejects camera with incomplete highQuality fields', () => {
        const cam = validCamera({ highQuality: { width: 1920, rtsp: '/stream' } });
        expect(validateConfig(logger, { onvif: [cam] })).toBe(false);
    });

    test('reports all errors across multiple invalid cameras', () => {
        const configs = [
            validCamera({ name: undefined }),
            validCamera({ dev: undefined })
        ];
        validateConfig(logger, { onvif: configs });
        expect(logger.error).toHaveBeenCalledTimes(2);
    });

    test('uses camera name in error messages when available', () => {
        const cam = validCamera({ dev: undefined });
        validateConfig(logger, { onvif: [cam] });
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"TestCam"'));
    });
});
