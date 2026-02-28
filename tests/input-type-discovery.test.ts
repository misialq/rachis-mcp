import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { KnowledgeGraph } from '../src/graph.js';
import type { Schema } from '../src/types.js';

const schema: Schema = {
    plugins: {
        assembly: {
            actions: {
                assemble_spades: {
                    description: 'Assemble paired-end reads into contigs.',
                    inputs: {
                        reads: { type: ['SampleData[PairedEndSequencesWithQuality]'], required: true },
                    },
                    parameters: {},
                    outputs: {
                        contigs: { type: ['SampleData[Contigs]'] },
                    },
                },
                map_reads: {
                    description: 'Map reads to assembled contigs.',
                    inputs: {
                        reads: { type: ['SampleData[PairedEndSequencesWithQuality]'], required: true },
                        contigs: { type: ['SampleData[Contigs]'], required: true },
                    },
                    parameters: {},
                    outputs: {
                        alignment_map: { type: ['SampleData[AlignmentMap]'] },
                    },
                },
            },
        },
        quality: {
            actions: {
                q_score: {
                    description: 'Filter reads by per-base quality.',
                    inputs: {
                        reads: {
                            type: [
                                'SampleData[SequencesWithQuality]',
                                'SampleData[PairedEndSequencesWithQuality]',
                            ],
                            required: true,
                        },
                    },
                    parameters: {},
                    outputs: {
                        filtered: { type: ['SampleData[SequencesWithQuality]'] },
                    },
                },
            },
        },
        feature_classifier: {
            actions: {
                classify_reads: {
                    description: 'Classify reads by taxon using a fitted classifier.',
                    inputs: {
                        sequences: { type: ['FeatureData[Sequence]'], required: true },
                    },
                    parameters: {},
                    outputs: {
                        taxonomy: { type: ['FeatureData[Taxonomy]'] },
                    },
                },
            },
        },
    },
    distributions: {
        assembly_only: {
            plugins: ['assembly'],
        },
        all: {
            plugins: ['assembly', 'quality', 'feature_classifier'],
        },
    },
    types: {
        'SampleData[PairedEndSequencesWithQuality]': 'Demultiplexed paired-end reads with quality scores.',
        'SampleData[SequencesWithQuality]': 'Demultiplexed single-end reads with quality scores.',
        'SampleData[Contigs]': 'Assembled contigs for each sample.',
        'SampleData[AlignmentMap]': 'Read alignments against contigs.',
        'FeatureData[Sequence]': 'Reference sequences associated with features.',
        'FeatureData[Taxonomy]': 'Hierarchical taxonomy annotations.',
    },
};

const toActionIds = (actions: { plugin: string, action: string }[]) =>
    actions.map(({ plugin, action }) => `${plugin}:${action}`).sort();

test('findCompatibleActions scopes matches by plugin filters', () => {
    const graph = new KnowledgeGraph(schema);

    const allMatches = toActionIds(graph.findCompatibleActions('SampleData[PairedEndSequencesWithQuality]'));
    const qualityOnly = toActionIds(
        graph.findCompatibleActions('SampleData[PairedEndSequencesWithQuality]', { plugin: 'quality' })
    );

    assert.deepEqual(allMatches, ['assembly:assemble_spades', 'assembly:map_reads', 'quality:q_score']);
    assert.deepEqual(qualityOnly, ['quality:q_score']);
});

test('findInputTypeCandidates ranks read-oriented sample types from free text', () => {
    const graph = new KnowledgeGraph(schema);
    const candidates = graph.findInputTypeCandidates('reads');

    assert.equal(candidates.length > 0, true);
    assert.equal(candidates[0].semantic_type, 'SampleData[PairedEndSequencesWithQuality]');
    assert.equal(candidates[0].match_sources.includes('input_name'), true);
    assert.equal(candidates[0].common_input_names.includes('reads'), true);
    assert.deepEqual(
        toActionIds(candidates[0].consumers),
        ['assembly:assemble_spades', 'assembly:map_reads', 'quality:q_score']
    );

    assert.equal(
        candidates.some((candidate) => candidate.semantic_type === 'SampleData[SequencesWithQuality]'),
        true
    );
});

test('findInputTypeCandidates preserves scoped consumers when filtering', () => {
    const graph = new KnowledgeGraph(schema);
    const candidates = graph.findInputTypeCandidates('reads', { distribution: 'assembly_only' });

    assert.equal(candidates.length > 0, true);
    assert.deepEqual(
        toActionIds(candidates[0].consumers),
        ['assembly:assemble_spades', 'assembly:map_reads']
    );
    assert.equal(candidates.every((candidate) => candidate.consumers.every((consumer) => consumer.plugin === 'assembly')), true);
});

test('findInputTypeCandidates can match types from type names and descriptions', () => {
    const graph = new KnowledgeGraph(schema);
    const candidates = graph.findInputTypeCandidates('contigs');

    assert.equal(candidates.length > 0, true);
    assert.equal(candidates[0].semantic_type, 'SampleData[Contigs]');
    assert.equal(candidates[0].match_sources.includes('type_name'), true);
    assert.equal(candidates[0].match_sources.includes('input_name'), true);
    assert.deepEqual(toActionIds(candidates[0].consumers), ['assembly:map_reads']);
});
