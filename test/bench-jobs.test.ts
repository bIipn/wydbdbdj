import { describe, expect, it } from 'vitest';
import { parseBenchArgs, renderBench, runBench } from '../src/cli/bench-jobs.js';

/**
 * `npm run bench:jobs` on a small data set: the benchmark still runs, and the two requests it measures stay
 * at a few database statements through the REAL routes (settlement, sign-in, the answer and all).
 * test/jobs-scale.test.ts holds the exact counts and the behaviour checks; this is the end-to-end guard.
 * Everything it seeds is synthetic (BENCH people at example.com).
 */
describe('npm run bench:jobs', () => {
  it('reads its options', () => {
    expect(parseBenchArgs([])).toMatchObject({ profiles: 3000, jobs: 300, posts: 24, reads: 15, seed: 20261114, out: null });
    expect(parseBenchArgs(['--profiles', '500', '--jobs=40', '--posts', '3', '--reads=2', '--seed', '7'])).toMatchObject({ profiles: 500, jobs: 40, posts: 3, reads: 2, seed: 7 });
    expect(() => parseBenchArgs(['--profiles', 'many'])).toThrow(/--profiles must be a whole number/);
    expect(() => parseBenchArgs(['--profiles', '10'])).toThrow(/at least 50/);
    expect(() => parseBenchArgs(['--fast'])).toThrow(/unknown option/);
  });

  it('a small run: posting and "my jobs" cost a few statements, whatever the data', async () => {
    const r = await runBench({ profiles: 80, jobs: 30, posts: 3, reads: 2, seed: 20261114, out: null });
    expect(r.seeded).toMatchObject({ profiles: 81, jobs: 30 });
    expect(r.produced.scoresPerPost).toBeGreaterThan(20); // the posts did reach people

    // Without the alert rules listening, a post is the same statements for 30 scored profiles as for 3,000.
    const post = r.routes['POST /api/jobs (alerts off)']!;
    expect(post.maxQueries).toBeLessThanOrEqual(16);
    // (With them, each ALERTED profile still costs the alert rules their own two statements, src/realtime:
    // that grows with the good fits a job has, not with the profiles it was scored for.)
    expect(r.routes['POST /api/jobs (alerts on)']!.medianQueries).toBeGreaterThanOrEqual(post.medianQueries);

    const heavy = r.routes['GET /api/jobs/mine (many jobs)']!;
    const light = r.routes['GET /api/jobs/mine (a worker)']!;
    expect(heavy.maxQueries).toBeLessThanOrEqual(12);
    expect(light.maxQueries).toBe(heavy.maxQueries); // a person with 21 jobs or a worker with a few: the same reads
    expect(heavy.bytes).toBeGreaterThan(5_000);

    for (const d of Object.values(r.digests)) expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(renderBench(r)).toContain('GET /api/jobs/mine (many jobs)');
  }, 120_000);
});
