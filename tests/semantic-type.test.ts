import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isTypeCompatible, parseSemanticType } from '../src/semantic-type.js';

test('parseSemanticType handles nested generics and properties', () => {
    const parsed = parseSemanticType("Collection[SampleData[SingleBowtie2Index % Properties('mags')]]");
    assert.equal(parsed.head, 'Collection');
    assert.equal(parsed.args.length, 1);
    assert.equal(parsed.args[0].head, 'SampleData');
    assert.equal(parsed.args[0].args.length, 1);
    assert.equal(parsed.args[0].args[0].head, 'SingleBowtie2Index');
});

test('isTypeCompatible matches property supersets', () => {
    const available = "SampleData[X % Properties('a', 'b')]";
    const required = "SampleData[X % Properties('a')]";
    assert.equal(isTypeCompatible(available, required), true);
});

test('isTypeCompatible supports unioned property requirements', () => {
    const available = "SampleData[X % Properties('a')]";
    const required = "SampleData[X % (Properties('a') | Properties('b'))]";
    assert.equal(isTypeCompatible(available, required), true);
});

test('isTypeCompatible preserves implicit List lift behavior', () => {
    assert.equal(isTypeCompatible('FeatureData[Sequence]', 'List[FeatureData[Sequence]]'), true);
});

