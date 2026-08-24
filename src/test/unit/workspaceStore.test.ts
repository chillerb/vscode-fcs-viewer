import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prune, type PersistedSessionsV1 } from '../../extension/workspaceStore';

// loadSessions/saveSession need a vscode ExtensionContext, so the pure codec
// pieces are covered here and the round-trip is covered by integration tests.

function sessions(n: number): PersistedSessionsV1 {
	const out: PersistedSessionsV1 = { version: 1, sessions: {} };
	for (let i = 0; i < n; i++) {
		out.sessions[`p${i}`] = { updatedAt: i, samples: [] };
	}
	return out;
}

describe('prune', () => {
	it('leaves a small record untouched', () => {
		const all = sessions(3);
		assert.equal(Object.keys(prune(all).sessions).length, 3);
	});

	it('keeps only the most recently updated sessions', () => {
		const pruned = prune(sessions(12), 8);
		const ids = Object.keys(pruned.sessions);
		assert.equal(ids.length, 8);
		// updatedAt 4..11 survive; 0..3 are dropped.
		assert.ok(ids.includes('p11'));
		assert.ok(ids.includes('p4'));
		assert.ok(!ids.includes('p3'));
	});

	it('is stable when exactly at the limit', () => {
		assert.equal(Object.keys(prune(sessions(8), 8).sessions).length, 8);
	});
});
