const EventService = require('../src/event-service');
const { parseTermination } = require('../src/event-service');

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

beforeEach(() => jest.clearAllMocks());

// ─── parseTermination ────────────────────────────────────────────────────────

describe('parseTermination', () => {
    const HOUR_MS = 3600 * 1000;

    beforeAll(() => jest.useFakeTimers({ now: new Date('2024-01-01T00:00:00.000Z') }));
    afterAll(() => jest.useRealTimers());

    test('null input returns now + 1 hour', () => {
        expect(parseTermination(null).toISOString()).toBe('2024-01-01T01:00:00.000Z');
    });

    test('PT1H returns now + 1 hour', () => {
        expect(parseTermination('PT1H').toISOString()).toBe('2024-01-01T01:00:00.000Z');
    });

    test('PT60S returns now + 60 seconds', () => {
        expect(parseTermination('PT60S').toISOString()).toBe('2024-01-01T00:01:00.000Z');
    });

    test('PT5M30S returns now + 5 minutes 30 seconds', () => {
        expect(parseTermination('PT5M30S').toISOString()).toBe('2024-01-01T00:05:30.000Z');
    });

    test('P1DT2H returns now + 26 hours', () => {
        expect(parseTermination('P1DT2H').toISOString()).toBe('2024-01-02T02:00:00.000Z');
    });

    test('absolute ISO timestamp is used directly', () => {
        expect(parseTermination('2024-06-15T12:00:00.000Z').toISOString()).toBe('2024-06-15T12:00:00.000Z');
    });

    test('invalid string falls back to now + 1 hour', () => {
        expect(parseTermination('garbage').toISOString()).toBe('2024-01-01T01:00:00.000Z');
    });
});

// ─── EventService.notify ─────────────────────────────────────────────────────

describe('EventService.notify', () => {
    function makeService() {
        return new EventService(logger, '127.0.0.1', 8080);
    }

    function futureTime(offsetMs = 3600_000) {
        return new Date(Date.now() + offsetMs);
    }

    test('queues an event for a pull subscription', () => {
        const svc = makeService();
        svc.subscriptions.set('s1', { type: 'pull', queue: [], terminationTime: futureTime() });

        svc.notify(true);

        const q = svc.subscriptions.get('s1').queue;
        expect(q).toHaveLength(1);
        expect(q[0].isMotion).toBe(true);
        expect(typeof q[0].utcTime).toBe('string');
    });

    test('queues false (motion end) correctly', () => {
        const svc = makeService();
        svc.subscriptions.set('s1', { type: 'pull', queue: [], terminationTime: futureTime() });

        svc.notify(false);

        expect(svc.subscriptions.get('s1').queue[0].isMotion).toBe(false);
    });

    test('queues to all active pull subscriptions', () => {
        const svc = makeService();
        svc.subscriptions.set('s1', { type: 'pull', queue: [], terminationTime: futureTime() });
        svc.subscriptions.set('s2', { type: 'pull', queue: [], terminationTime: futureTime() });

        svc.notify(true);

        expect(svc.subscriptions.get('s1').queue).toHaveLength(1);
        expect(svc.subscriptions.get('s2').queue).toHaveLength(1);
    });

    test('removes expired subscriptions during notify', () => {
        const svc = makeService();
        svc.subscriptions.set('expired', { type: 'pull', queue: [], terminationTime: new Date(Date.now() - 1) });
        svc.subscriptions.set('active',  { type: 'pull', queue: [], terminationTime: futureTime() });

        svc.notify(true);

        expect(svc.subscriptions.has('expired')).toBe(false);
        expect(svc.subscriptions.get('active').queue).toHaveLength(1);
    });

    test('multiple notify calls accumulate in the queue', () => {
        const svc = makeService();
        svc.subscriptions.set('s1', { type: 'pull', queue: [], terminationTime: futureTime() });

        svc.notify(true);
        svc.notify(false);
        svc.notify(true);

        expect(svc.subscriptions.get('s1').queue).toHaveLength(3);
    });
});

// ─── Subscription lifecycle ───────────────────────────────────────────────────
// Test pull subscription queue drain (mimics PullMessages behaviour)

describe('EventService subscription queue', () => {
    test('splice drains up to the requested limit', () => {
        const svc = new EventService(logger, '127.0.0.1', 8080);
        const sub = { type: 'pull', queue: [], terminationTime: new Date(Date.now() + 3600_000) };
        svc.subscriptions.set('s1', sub);

        svc.notify(true);
        svc.notify(false);
        svc.notify(true);

        // Simulate PullMessages with limit=2
        const drained = sub.queue.splice(0, 2);
        expect(drained).toHaveLength(2);
        expect(sub.queue).toHaveLength(1);
    });
});
