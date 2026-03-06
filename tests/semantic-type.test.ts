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

test('parseSemanticType preserves quoted property values and union options on nested args', () => {
    const quoted = parseSemanticType(`SampleData[X % Properties("paired, end", 'reads')]`);
    const unioned = parseSemanticType(`SampleData[X % (Properties('reads') | Properties('single-end'))]`);

    assert.equal(quoted.args[0].propertyOptions.length, 1);
    assert.equal(quoted.args[0].propertyOptions[0].has('paired, end'), true);
    assert.equal(quoted.args[0].propertyOptions[0].has('reads'), true);

    assert.equal(unioned.args[0].propertyOptions.length, 2);
    assert.equal(unioned.args[0].propertyOptions[0].has('reads'), true);
    assert.equal(unioned.args[0].propertyOptions[1].has('single-end'), true);
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

test('isTypeCompatible supports available-side unions', () => {
    assert.equal(
        isTypeCompatible('FeatureData[Sequence] | FeatureData[Taxonomy]', 'FeatureData[Taxonomy]'),
        true
    );
});

test('isTypeCompatible rejects missing required properties', () => {
    assert.equal(
        isTypeCompatible("SampleData[X % Properties('a')]", "SampleData[X % Properties('a', 'b')]"),
        false
    );
});

test('isTypeCompatible rejects incompatible heads', () => {
    assert.equal(isTypeCompatible('FeatureData[Sequence]', 'FeatureTable[Frequency]'), false);
});

test('isTypeCompatible matches generic arg against union arg', () => {
    // SampleData[PairedEndSequencesWithQuality] should satisfy
    // SampleData[SequencesWithQuality | PairedEndSequencesWithQuality | JoinedSequencesWithQuality]
    assert.equal(
        isTypeCompatible(
            'SampleData[PairedEndSequencesWithQuality]',
            'SampleData[SequencesWithQuality | PairedEndSequencesWithQuality | JoinedSequencesWithQuality]'
        ),
        true
    );
    // and via List lift
    assert.equal(
        isTypeCompatible(
            'SampleData[PairedEndSequencesWithQuality]',
            'List[SampleData[SequencesWithQuality | PairedEndSequencesWithQuality | JoinedSequencesWithQuality]]'
        ),
        true
    );
    // non-member should still fail
    assert.equal(
        isTypeCompatible(
            'SampleData[Contigs]',
            'SampleData[SequencesWithQuality | PairedEndSequencesWithQuality | JoinedSequencesWithQuality]'
        ),
        false
    );
});
