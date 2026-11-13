import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createBus, type BusEvent } from '../src/realtime/bus.js';

const price = (seriesId: string): BusEvent => ({ type: 'price', seriesId, changePct: 0, period: 'TEST' });

describe('event bus', () => {
  it('delivers an event to the listeners of its type, and only those', async () => {
    const bus = createBus();
    const prices: string[] = [];
    const scans: string[] = [];
    bus.on('price', (e) => void prices.push(e.seriesId)); // e is narrowed to the 'price' event
    bus.on('scan', (e) => void scans.push(e.report.startedAt));
    await bus.emit(price('TEST-A'));
    await bus.emit(price('TEST-B'));
    expect(prices).toEqual(['TEST-A', 'TEST-B']);
    expect(scans).toEqual([]);
  });

  it('stops delivering after off() or the returned unsubscribe', async () => {
    const bus = createBus();
    let a = 0;
    let b = 0;
    const listenerA = () => void a++;
    bus.on('price', listenerA);
    const stopB = bus.on('price', () => void b++);
    await bus.emit(price('TEST'));
    bus.off('price', listenerA);
    stopB();
    stopB(); // twice is harmless
    await bus.emit(price('TEST'));
    expect([a, b]).toEqual([1, 1]);
  });

  it('isolates listeners: one that throws or rejects cannot break emit or the others', async () => {
    const errors: Array<[string, string]> = [];
    const bus = createBus((err, event) => void errors.push([(err as Error).message, event.type]));
    const got: string[] = [];
    bus.on('price', () => {
      throw new Error('sync boom');
    });
    bus.on('price', async () => {
      throw new Error('async boom');
    });
    bus.on('price', (e) => void got.push(e.seriesId));
    await expect(bus.emit(price('TEST'))).resolves.toBeUndefined();
    expect(got).toEqual(['TEST']);
    expect(errors).toEqual([['sync boom', 'price'], ['async boom', 'price']]);
  });

  it('survives an error handler that throws', async () => {
    const bus = createBus(() => {
      throw new Error('handler boom');
    });
    let ok = 0;
    bus.on('price', () => {
      throw new Error('boom');
    });
    bus.on('price', () => void ok++);
    await expect(bus.emit(price('TEST'))).resolves.toBeUndefined();
    expect(ok).toBe(1);
  });

  it('emit resolves only after async listeners have finished', async () => {
    const bus = createBus();
    let done = false;
    bus.on('price', async () => {
      await new Promise((r) => setTimeout(r, 15));
      done = true;
    });
    await bus.emit(price('TEST'));
    expect(done).toBe(true);
  });

  it('a listener may unsubscribe itself (or others) while an event is being delivered', async () => {
    const bus = createBus();
    const seen: string[] = [];
    const stopFirst = bus.on('price', () => {
      seen.push('first');
      stopFirst();
    });
    bus.on('price', () => void seen.push('second'));
    await bus.emit(price('TEST'));
    await bus.emit(price('TEST'));
    expect(seen).toEqual(['first', 'second', 'second']);
  });

  it('property: after any mix of subscribes and unsubscribes, emit reaches exactly the current subscribers once', async () => {
    type Op = { kind: 'on' | 'off'; listener: number; type: 'price' | 'scan' };
    const op = fc.record<Op>({
      kind: fc.constantFrom('on', 'off'), listener: fc.integer({ min: 0, max: 5 }), type: fc.constantFrom('price', 'scan'),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 40 }), async (ops) => {
        const bus = createBus();
        const calls = new Map<number, number>();
        const listeners = Array.from({ length: 6 }, (_, i) => () => void calls.set(i, (calls.get(i) ?? 0) + 1));
        const model = { price: new Set<number>(), scan: new Set<number>() };
        for (const o of ops) {
          if (o.kind === 'on') {
            bus.on(o.type, listeners[o.listener]!);
            model[o.type].add(o.listener);
          } else {
            bus.off(o.type, listeners[o.listener]!);
            model[o.type].delete(o.listener);
          }
        }
        await bus.emit(price('TEST'));
        expect([...calls.keys()].sort()).toEqual([...model.price].sort());
        expect([...calls.values()].every((n) => n === 1)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
