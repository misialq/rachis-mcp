import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeActionIds, toActionId, toDisplayName } from '../src/action-utils.js';

test('toDisplayName and toActionId render identifiers with hyphens', () => {
    assert.equal(toDisplayName('feature_classifier'), 'feature-classifier');
    assert.equal(toActionId('feature_classifier', 'classify_sklearn'), 'feature-classifier:classify-sklearn');
});

test('normalizeActionIds returns sorted unique action IDs', () => {
    const normalized = normalizeActionIds([
        'feature-classifier:classify-sklearn',
        'assembly:assemble-spades',
        'feature-classifier:classify-sklearn',
        'annotate:align',
    ]);

    assert.deepEqual(normalized, [
        'annotate:align',
        'assembly:assemble-spades',
        'feature-classifier:classify-sklearn',
    ]);
});
