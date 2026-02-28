import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { KnowledgeGraph } from '../src/graph.js';
import type { Schema } from '../src/types.js';

const schema: Schema = {
    plugins: {
        planner: {
            actions: {
                combine: {
                    description: 'Combine two required inputs.',
                    inputs: {
                        left: { type: ['TypeA'], required: true },
                        right: { type: ['TypeB'], required: true },
                    },
                    parameters: {},
                    outputs: {
                        combined: { type: ['TypeC'] },
                    },
                },
                convert: {
                    description: 'Convert TypeA to TypeTarget.',
                    inputs: {
                        source: { type: ['TypeA'], required: true },
                    },
                    parameters: {},
                    outputs: {
                        target: { type: ['TypeTarget'] },
                    },
                },
                derive_b: {
                    description: 'Derive TypeB from TypeA.',
                    inputs: {
                        source: { type: ['TypeA'], required: true },
                    },
                    parameters: {},
                    outputs: {
                        derived: { type: ['TypeB'] },
                    },
                },
                property_consumer: {
                    description: 'Consume index data with contigs property.',
                    inputs: {
                        index: {
                            type: ["SampleData[SingleBowtie2Index % Properties('contigs')]"],
                            required: true,
                        },
                    },
                    parameters: {},
                    outputs: {
                        result: { type: ['TypeIndexed'] },
                    },
                },
                metadata_splitter: {
                    description: 'Uses metadata and regular parameters.',
                    inputs: {},
                    parameters: {
                        metadata: { type: 'Metadata', required: true },
                        sample_metadata: { type: 'MetadataColumn[Categorical]', required: false },
                        threshold: { type: 'Int', required: false },
                    },
                    outputs: {
                        result: { type: ['TypeMetadataSplit'] },
                    },
                },
            },
        },
        taxa: {
            actions: {
                profile: {
                    description: 'Taxonomic profiling from TypeA.',
                    inputs: {
                        sequences: { type: ['TypeA'], required: true },
                    },
                    parameters: {},
                    outputs: {
                        profile: { type: ['TypeC'] },
                    },
                },
            },
        },
        assembly: {
            actions: {
                assemble_c: {
                    description: 'Assembly workflow producing TypeC from TypeA and TypeB.',
                    inputs: {
                        reads: { type: ['TypeA'], required: true },
                        support: { type: ['TypeB'], required: true },
                    },
                    parameters: {},
                    outputs: {
                        assembled: { type: ['TypeC'] },
                    },
                },
            },
        },
    },
    distributions: {
        test: {
            plugins: ['planner', 'taxa', 'assembly'],
        },
    },
    types: {},
};

const toActionIds = (actions: { plugin: string, action: string }[]) =>
    actions.map(({ plugin, action }) => `${plugin}:${action}`);

test('findConsumers required_inputs enforces all required inputs', () => {
    const graph = new KnowledgeGraph(schema);

    const partial = toActionIds(graph.findConsumers(['TypeA'], 'required_inputs'));
    assert.equal(partial.includes('planner:combine'), false);

    const full = toActionIds(graph.findConsumers(['TypeA', 'TypeB'], 'required_inputs'));
    assert.equal(full.includes('planner:combine'), true);
});

test('findConsumers strict_consumption rejects extra unmatched input types', () => {
    const graph = new KnowledgeGraph(schema);

    const requiredMode = toActionIds(graph.findConsumers(['TypeA', 'TypeB', 'TypeZ'], 'required_inputs'));
    const strictMode = toActionIds(graph.findConsumers(['TypeA', 'TypeB', 'TypeZ'], 'strict_consumption'));

    assert.equal(requiredMode.includes('planner:combine'), true);
    assert.equal(strictMode.includes('planner:combine'), false);
});

test('findConsumers uses compatibility checks instead of exact matching', () => {
    const graph = new KnowledgeGraph(schema);
    const consumers = toActionIds(
        graph.findConsumers(["SampleData[SingleBowtie2Index % Properties('mags', 'contigs')]"], 'required_inputs')
    );

    assert.equal(consumers.includes('planner:property_consumer'), true);
});

test('findConsumers filters results by distribution', () => {
    const constrainedSchema: Schema = {
        ...schema,
        distributions: {
            only_taxa: {
                plugins: ['taxa'],
            },
        },
    };
    const graph = new KnowledgeGraph(constrainedSchema);
    const consumers = toActionIds(graph.findConsumers(['TypeA'], 'required_inputs', { distribution: 'only_taxa' }));

    assert.deepEqual(consumers, ['taxa:profile']);
});

test('findConsumers filters results by plugin', () => {
    const graph = new KnowledgeGraph(schema);
    const consumers = toActionIds(graph.findConsumers(['TypeA'], 'required_inputs', { plugin: 'planner' }));

    assert.deepEqual(consumers.sort(), ['planner:convert', 'planner:derive_b']);
});

test('findConsumers returns empty when plugin is outside selected distribution', () => {
    const constrainedSchema: Schema = {
        ...schema,
        distributions: {
            only_taxa: {
                plugins: ['taxa'],
            },
        },
    };
    const graph = new KnowledgeGraph(constrainedSchema);
    const consumers = toActionIds(
        graph.findConsumers(['TypeA'], 'required_inputs', { distribution: 'only_taxa', plugin: 'planner' })
    );

    assert.deepEqual(consumers, []);
});

test('findConsumers throws for unknown distribution or plugin filters', () => {
    const graph = new KnowledgeGraph(schema);

    assert.throws(() => graph.findConsumers(['TypeA'], 'required_inputs', { distribution: 'missing' }), /Distribution 'missing' not found/);
    assert.throws(() => graph.findConsumers(['TypeA'], 'required_inputs', { plugin: 'missing_plugin' }), /Plugin 'missing_plugin' not found/);
});

test('findProducers filters results by distribution', () => {
    const graph = new KnowledgeGraph(schema);
    const producers = toActionIds(graph.findProducers(['TypeC'], { distribution: 'test' }));

    assert.deepEqual(producers.sort(), ['assembly:assemble_c', 'planner:combine', 'taxa:profile']);
});

test('findProducers filters results by plugin', () => {
    const graph = new KnowledgeGraph(schema);
    const producers = toActionIds(graph.findProducers(['TypeC'], { plugin: 'planner' }));

    assert.deepEqual(producers, ['planner:combine']);
});

test('findProducers returns empty when plugin is outside selected distribution', () => {
    const constrainedSchema: Schema = {
        ...schema,
        distributions: {
            only_taxa: {
                plugins: ['taxa'],
            },
        },
    };
    const constrainedGraph = new KnowledgeGraph(constrainedSchema);
    const producers = toActionIds(constrainedGraph.findProducers(['TypeC'], { distribution: 'only_taxa', plugin: 'planner' }));

    assert.deepEqual(producers, []);
});

test('findProducers throws for unknown distribution or plugin filters', () => {
    const graph = new KnowledgeGraph(schema);

    assert.throws(() => graph.findProducers(['TypeC'], { distribution: 'missing' }), /Distribution 'missing' not found/);
    assert.throws(() => graph.findProducers(['TypeC'], { plugin: 'missing_plugin' }), /Plugin 'missing_plugin' not found/);
});

test('getAction separates metadata-typed parameters into metadata category', () => {
    const graph = new KnowledgeGraph(schema);
    const action = graph.getAction('planner', 'metadata_splitter');

    assert.notEqual(action, undefined);
    assert.deepEqual(Object.keys(action!.parameters).sort(), ['threshold']);
    assert.deepEqual(Object.keys(action!.metadata || {}).sort(), ['metadata', 'sample_metadata']);
    assert.equal(action!.parameters.metadata, undefined);
    assert.equal(action!.parameters.sample_metadata, undefined);
});
