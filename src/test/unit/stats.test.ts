import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBasicStats, computeQuantiles } from '../../common/fcs/stats';
import { forward, inverse, defined, defaultCofactorFor, defaultLogParams, logRange, transformColumn, type TransformSpec } from '../../common/fcs/transform';
import { parseFcs } from '../../common/fcs';
import { makeFcs } from './fixtures/makeFcs';

describe('computeBasicStats', () => {
	it('matches hand-computed values', () => {
		const s = computeBasicStats(Float32Array.from([2, 4, 4, 4, 5, 5, 7, 9]), 0);
		assert.equal(s.count, 8);
		assert.equal(s.min, 2);
		assert.equal(s.max, 9);
		assert.equal(s.mean, 5);
		// Sample (n-1) standard deviation of this classic set is sqrt(32/7).
		assert.ok(Math.abs(s.std - Math.sqrt(32 / 7)) < 1e-6);
	});

	it('counts zeros, negatives and non-finite values separately', () => {
		const s = computeBasicStats(Float32Array.from([0, 0, -1, 5, NaN, Infinity]), 3);
		assert.equal(s.channel, 3);
		assert.equal(s.count, 4);
		assert.equal(s.nonFinite, 2);
		assert.equal(s.zeroCount, 2);
		assert.equal(s.negativeCount, 1);
		assert.equal(s.min, -1);
		assert.equal(s.max, 5);
	});

	it('handles an all-empty column', () => {
		const s = computeBasicStats(new Float32Array(0), 0);
		assert.equal(s.count, 0);
		assert.ok(Number.isNaN(s.mean));
	});
});

describe('computeQuantiles', () => {
	// R type-7: quantile(1:10, c(.25,.5,.75)) == 3.25, 5.5, 7.75
	it('uses the R type-7 interpolation convention', () => {
		const col = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		const [q1, med, q3] = computeQuantiles(col, [0.25, 0.5, 0.75]);
		assert.ok(Math.abs(q1! - 3.25) < 1e-6, `q1 was ${q1}`);
		assert.ok(Math.abs(med! - 5.5) < 1e-6, `median was ${med}`);
		assert.ok(Math.abs(q3! - 7.75) < 1e-6, `q3 was ${q3}`);
	});

	it('handles an odd-length column', () => {
		const [med] = computeQuantiles(Float32Array.from([5, 1, 3, 2, 4]), [0.5]);
		assert.equal(med, 3);
	});

	it('excludes non-finite values', () => {
		const [med] = computeQuantiles(Float32Array.from([1, 2, 3, NaN, NaN]), [0.5]);
		assert.equal(med, 2);
	});

	it('agrees with a full sort on shuffled data', () => {
		const n = 5000;
		const col = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			col[i] = Math.sin(i * 12.9898) * 10000;
		}
		const sorted = Float32Array.from(col).sort();
		const probs = [0.01, 0.25, 0.5, 0.75, 0.99];
		const got = computeQuantiles(col, probs);
		probs.forEach((p, i) => {
			const h = (n - 1) * p;
			const lo = Math.floor(h);
			const hi = Math.ceil(h);
			const want = sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
			assert.ok(Math.abs(got[i]! - want) < 1e-3, `p=${p}: ${got[i]} vs ${want}`);
		});
	});
});

describe('transforms', () => {
	const specs: TransformSpec[] = [
		{ kind: 'linear', cofactor: 1 },
		{ kind: 'log', cofactor: 1 },
		{ kind: 'arsinh', cofactor: 5 },
		{ kind: 'arsinh', cofactor: 150 },
	];

	it('are monotone increasing, which is what makes raw quantiles reusable', () => {
		for (const spec of specs) {
			let prev = -Infinity;
			for (let v = spec.kind === 'log' ? 0.01 : -1000; v < 10000; v += 37.3) {
				const t = forward(v, spec);
				assert.ok(t > prev, `${spec.kind}(${spec.cofactor}) not monotone at ${v}`);
				prev = t;
			}
		}
	});

	it('round-trip through their inverse', () => {
		for (const spec of specs) {
			for (const v of [0.5, 1, 42, 1000, 99999]) {
				const back = inverse(forward(v, spec), spec);
				assert.ok(Math.abs(back - v) < Math.max(1e-6, Math.abs(v) * 1e-6), `${spec.kind}: ${back} vs ${v}`);
			}
		}
	});

	it('arsinh is defined for negatives and symmetric about zero', () => {
		const spec: TransformSpec = { kind: 'arsinh', cofactor: 5 };
		assert.ok(defined(-200, spec));
		assert.equal(forward(0, spec), 0);
		assert.ok(Math.abs(forward(-37, spec) + forward(37, spec)) < 1e-12);
	});

	it('arsinh stays accurate near zero', () => {
		// The naive log(u + sqrt(u*u+1)) formula loses all precision here.
		const spec: TransformSpec = { kind: 'arsinh', cofactor: 5 };
		const v = 1e-8;
		assert.ok(Math.abs(forward(v, spec) - v / 5) < 1e-20);
	});

	it('log excludes non-positive values rather than clamping them', () => {
		const spec: TransformSpec = { kind: 'log', cofactor: 1 };
		assert.equal(defined(0, spec), false);
		assert.equal(defined(-5, spec), false);
		assert.equal(defined(5, spec), true);
		const dst = new Float32Array(3);
		transformColumn(Float32Array.from([-1, 0, 100]), dst, spec);
		assert.ok(Number.isNaN(dst[0]!));
		assert.ok(Number.isNaN(dst[1]!));
		// GatingML flog with the default M = T = 1 is log10(x) + 1.
		assert.equal(dst[2], 3);
	});
});

describe('flog (GatingML 2.0)', () => {
	// flog(x, M, T) = (1/M) * log10(x / T) + 1
	it('matches the specification for the default parameters', () => {
		const spec: TransformSpec = { kind: 'log', cofactor: 1 };
		assert.equal(forward(1, spec), 1, 'flog(T) = 1');
		assert.equal(forward(10, spec), 2);
		assert.ok(Math.abs(forward(0.1, spec) - 0) < 1e-12, 'flog(T*10^-M) = 0');
	});

	it('honours M and T', () => {
		const spec: TransformSpec = { kind: 'log', cofactor: 1, logM: 4, logT: 262144 };
		assert.ok(Math.abs(forward(262144, spec) - 1) < 1e-12, 'the top of scale maps to 1');
		assert.ok(Math.abs(forward(262144 / 1e4, spec) - 0) < 1e-12, 'M decades below maps to 0');
	});

	it('round-trips through its inverse', () => {
		const spec: TransformSpec = { kind: 'log', cofactor: 1, logM: 4, logT: 262144 };
		for (const v of [0.5, 42, 1000, 262144]) {
			assert.ok(Math.abs(inverse(forward(v, spec), spec) - v) < Math.abs(v) * 1e-9);
		}
	});

	it('stays monotone for any M and T', () => {
		const spec: TransformSpec = { kind: 'log', cofactor: 1, logM: 4.5, logT: 1024 };
		let prev = -Infinity;
		for (let v = 0.01; v < 1e5; v *= 1.7) {
			const t = forward(v, spec);
			assert.ok(t > prev);
			prev = t;
		}
	});
});

describe('flog parameter defaults', () => {
	/**
	 * The V2 complaint was that M and T did nothing. They could not: flog is
	 * affine in log10, so on a percentile-derived range a change to either
	 * shifted the values, the range and the ticks by the same amount and the
	 * picture never moved. They only bite because the range is now theirs, and
	 * that only works if the defaults frame the data instead of the spec's
	 * M = T = 1, which would show 0.1 to 1 and hide everything.
	 */
	it('puts the top of scale at the next power of ten above the data', () => {
		assert.equal(defaultLogParams(45_000, 12).t, 100_000);
		assert.equal(defaultLogParams(1000, 1).t, 1000);
	});

	it('covers the decades the data actually spans', () => {
		const p = defaultLogParams(1e5, 1e2);
		assert.equal(p.m, 3);
		assert.deepEqual(logRange(p), [100, 100_000]);
	});

	it('clamps to a readable number of decades', () => {
		assert.equal(defaultLogParams(1e5, 1e-9).m, 6, 'a stray tiny value must not flatten the axis');
		assert.equal(defaultLogParams(1000, 900).m, 1, 'below one decade a log axis is pointless');
	});

	it('survives a channel with no positive values at all', () => {
		const p = defaultLogParams(-Infinity, Infinity);
		assert.ok(Number.isFinite(p.m) && Number.isFinite(p.t));
		assert.ok(p.t > 0 && p.m >= 1);
	});

	it('frames the data: the range holds the values it was derived from', () => {
		const [lo, hi] = logRange(defaultLogParams(45_000, 12));
		assert.ok(lo <= 12 && hi >= 45_000);
	});

	it('maps its own range onto exactly [0, 1]', () => {
		const p = defaultLogParams(45_000, 12);
		const spec: TransformSpec = { kind: 'log', cofactor: 1, logM: p.m, logT: p.t };
		const [lo, hi] = logRange(p);
		assert.ok(Math.abs(forward(lo, spec) - 0) < 1e-12);
		assert.ok(Math.abs(forward(hi, spec) - 1) < 1e-12);
	});
});

describe('defaultCofactorFor', () => {
	const ch = [{ name: 'A', bits: 32, range: 1024 }];
	it('picks 5 for mass cytometry', () => {
		const m = parseFcs(makeFcs({ channels: ch, events: [[1]], extraKeywords: { $CYT: 'DVSSCIENCES-CYTOF-1.3.0' } })).metadata;
		assert.equal(defaultCofactorFor(m), 5);
	});
	it('picks 150 for a fluorescence file with a spillover matrix', () => {
		const m = parseFcs(makeFcs({
			channels: [{ name: 'B515-A', bits: 32, range: 1024 }, { name: 'G560-A', bits: 32, range: 1024 }],
			events: [[1, 2]],
			extraKeywords: { $CYT: 'LSRII' },
			spillover: { keyword: 'SPILL', channels: ['B515-A', 'G560-A'], matrix: [[1, 0], [0, 1]] },
		})).metadata;
		assert.equal(defaultCofactorFor(m), 150);
	});
});
