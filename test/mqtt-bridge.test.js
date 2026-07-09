const MqttBridge = require('../src/mqtt-bridge');

const logger = { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() };
const eventService = { notify: jest.fn() };

beforeEach(() => jest.clearAllMocks());

// Build a frigate/reviews payload for a given camera
function reviewPayload(type, { camera = 'garden', id = 'rev-1', severity = 'alert', objects = [] } = {}) {
    return JSON.stringify({ type, after: { id, camera, severity, data: { objects } } });
}

describe('MqttBridge._matchesFilter', () => {
    test('no filter: always returns true regardless of objects', () => {
        const b = new MqttBridge(logger, 'garden', {}, eventService, null);
        expect(b._matchesFilter(['car'])).toBe(true);
        expect(b._matchesFilter([])).toBe(true);
    });

    test('with filter: true when any detected object is in the list', () => {
        const b = new MqttBridge(logger, 'garden', {}, eventService, ['person', 'cat']);
        expect(b._matchesFilter(['person'])).toBe(true);
        expect(b._matchesFilter(['dog', 'cat'])).toBe(true);
    });

    test('with filter: false when no detected object matches', () => {
        const b = new MqttBridge(logger, 'garden', {}, eventService, ['person']);
        expect(b._matchesFilter(['car', 'truck'])).toBe(false);
        expect(b._matchesFilter([])).toBe(false);
    });

    test('filter matching is case-insensitive', () => {
        const b = new MqttBridge(logger, 'garden', {}, eventService, ['Person']);
        expect(b._matchesFilter(['person'])).toBe(true);
        expect(b._matchesFilter(['PERSON'])).toBe(true);
    });

    test('empty objects array is normalised to null (no filter)', () => {
        const b = new MqttBridge(logger, 'garden', {}, eventService, []);
        expect(b.objects).toBeNull();
    });
});

describe('MqttBridge._handleMessage — routing', () => {
    let bridge;
    beforeEach(() => {
        bridge = new MqttBridge(logger, 'garden', {}, eventService, ['person']);
    });

    test('ignores messages on non-reviews topics', () => {
        bridge._handleMessage('frigate/events', reviewPayload('new', { objects: ['person'] }), 'frigate');
        expect(eventService.notify).not.toHaveBeenCalled();
    });

    test('ignores reviews for a different camera', () => {
        bridge._handleMessage('frigate/reviews', reviewPayload('new', { camera: 'alleyway', objects: ['person'] }), 'frigate');
        expect(eventService.notify).not.toHaveBeenCalled();
    });

    test('handles invalid JSON without throwing', () => {
        expect(() => bridge._handleMessage('frigate/reviews', 'not-json', 'frigate')).not.toThrow();
        expect(eventService.notify).not.toHaveBeenCalled();
    });

    test('respects a custom topic prefix', () => {
        bridge._handleMessage('myhome/reviews', reviewPayload('new', { objects: ['person'] }), 'myhome');
        expect(eventService.notify).toHaveBeenCalledWith(true);
    });
});

describe('MqttBridge._handleMessage — new/update events', () => {
    let bridge;
    beforeEach(() => {
        bridge = new MqttBridge(logger, 'garden', {}, eventService, ['person', 'cat']);
    });

    test('fires notify(true) for new alert review with matching object', () => {
        bridge._handleMessage('frigate/reviews', reviewPayload('new', { objects: ['person'] }), 'frigate');
        expect(eventService.notify).toHaveBeenCalledWith(true);
    });

    test('does not fire for detection-severity reviews (motion only, no tracked objects)', () => {
        bridge._handleMessage('frigate/reviews', reviewPayload('new', { severity: 'detection', objects: ['person'] }), 'frigate');
        expect(eventService.notify).not.toHaveBeenCalled();
    });

    test('does not fire when detected objects do not match the filter', () => {
        bridge._handleMessage('frigate/reviews', reviewPayload('new', { objects: ['car'] }), 'frigate');
        expect(eventService.notify).not.toHaveBeenCalled();
    });

    test('fires only once when new and update arrive for the same review ID', () => {
        bridge._handleMessage('frigate/reviews', reviewPayload('new',    { objects: ['person'] }), 'frigate');
        bridge._handleMessage('frigate/reviews', reviewPayload('update', { objects: ['person', 'cat'] }), 'frigate');
        expect(eventService.notify).toHaveBeenCalledTimes(1);
        expect(eventService.notify).toHaveBeenCalledWith(true);
    });

    test('fires on update when new was skipped (filter now matches after update)', () => {
        // new arrives with non-matching objects
        bridge._handleMessage('frigate/reviews', reviewPayload('new',    { objects: ['car'] }), 'frigate');
        // update arrives with a matching object added
        bridge._handleMessage('frigate/reviews', reviewPayload('update', { objects: ['car', 'person'] }), 'frigate');
        expect(eventService.notify).toHaveBeenCalledTimes(1);
        expect(eventService.notify).toHaveBeenCalledWith(true);
    });
});

describe('MqttBridge._handleMessage — end events', () => {
    let bridge;
    beforeEach(() => {
        bridge = new MqttBridge(logger, 'garden', {}, eventService, ['person']);
    });

    test('fires notify(false) when end follows an active review', () => {
        bridge._handleMessage('frigate/reviews', reviewPayload('new', { objects: ['person'] }), 'frigate');
        bridge._handleMessage('frigate/reviews', reviewPayload('end', { objects: ['person'] }), 'frigate');
        expect(eventService.notify).toHaveBeenCalledTimes(2);
        expect(eventService.notify).toHaveBeenNthCalledWith(2, false);
    });

    test('does not fire end for a review that was never activated', () => {
        bridge._handleMessage('frigate/reviews', reviewPayload('end', { objects: ['person'] }), 'frigate');
        expect(eventService.notify).not.toHaveBeenCalled();
    });

    test('clears the review ID so a second end does not double-fire', () => {
        bridge._handleMessage('frigate/reviews', reviewPayload('new', { objects: ['person'] }), 'frigate');
        bridge._handleMessage('frigate/reviews', reviewPayload('end', { objects: ['person'] }), 'frigate');
        bridge._handleMessage('frigate/reviews', reviewPayload('end', { objects: ['person'] }), 'frigate');
        expect(eventService.notify).toHaveBeenCalledTimes(2);
    });
});

describe('MqttBridge._handleMessage — no objects filter', () => {
    let bridge;
    beforeEach(() => {
        bridge = new MqttBridge(logger, 'garden', {}, eventService, null);
    });

    test('fires for any alert-severity review regardless of object label', () => {
        bridge._handleMessage('frigate/reviews', reviewPayload('new', { severity: 'alert', objects: ['car'] }), 'frigate');
        expect(eventService.notify).toHaveBeenCalledWith(true);
    });

    test('does not fire for detection-severity even without a filter', () => {
        bridge._handleMessage('frigate/reviews', reviewPayload('new', { severity: 'detection', objects: [] }), 'frigate');
        expect(eventService.notify).not.toHaveBeenCalled();
    });
});
