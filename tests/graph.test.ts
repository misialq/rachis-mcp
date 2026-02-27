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

test('findWorkflow step includes backward-compatible fields and action_id', () => {
    const graph = new KnowledgeGraph(schema);
    const workflow = graph.findWorkflow('TypeA', 'TypeTarget', 3);

    assert.notEqual(workflow, null);
    assert.equal(workflow!.length > 0, true);
    assert.equal(workflow![0].plugin, 'planner');
    assert.equal(workflow![0].action, 'convert');
    assert.equal(workflow![0].action_id, 'planner:convert');
    assert.equal(workflow![0].output_type, 'TypeTarget');
});

test('planWorkflowMulti builds a combined plan for multiple targets', () => {
    const graph = new KnowledgeGraph(schema);
    const plan = graph.planWorkflowMulti(['TypeA'], ['TypeTarget', 'TypeC'], 4);

    assert.deepEqual(plan.missing_inputs, []);
    assert.equal(plan.achieved_targets.includes('TypeTarget'), true);
    assert.equal(plan.achieved_targets.includes('TypeC'), true);
    assert.equal(plan.steps.some((step) => step.action_id === 'planner:convert'), true);
    assert.equal(plan.steps.some((step) => step.output_type === 'TypeC'), true);
});

test('planWorkflowMulti returns partial results with missing_inputs for unsatisfied targets', () => {
    const graph = new KnowledgeGraph(schema);
    const plan = graph.planWorkflowMulti(['TypeA'], ['TypeTarget', 'TypeUnknown'], 3);

    assert.equal(plan.achieved_targets.includes('TypeTarget'), true);
    assert.equal(plan.missing_inputs.includes('TypeUnknown'), true);
    assert.equal(plan.warnings.length > 0, true);
});

test('planWorkflowMulti deduplicates shared actions across targets', () => {
    const graph = new KnowledgeGraph(schema);
    const plan = graph.planWorkflowMulti(['TypeA'], ['TypeB', 'TypeC'], 4);

    const deriveBCount = plan.steps.filter((step) => step.action_id === 'planner:derive_b').length;
    assert.equal(deriveBCount, 1);
});

test('planWorkflowMulti allowed_plugins constraint restricts planner choices', () => {
    const graph = new KnowledgeGraph(schema);
    const constrainedPlan = graph.planWorkflowMulti(['TypeA'], ['TypeC'], 4, {
        allowed_plugins: ['taxa'],
    });

    assert.equal(constrainedPlan.steps.some((step) => step.plugin === 'taxa'), true);
    assert.equal(constrainedPlan.steps.some((step) => step.plugin === 'planner'), false);
});

test('planWorkflowMulti disallowed_actions excludes matching actions', () => {
    const graph = new KnowledgeGraph(schema);
    const constrainedPlan = graph.planWorkflowMulti(['TypeA'], ['TypeC'], 4, {
        disallowed_actions: ['taxa:*'],
    });

    assert.equal(constrainedPlan.steps.some((step) => step.plugin === 'taxa'), false);
    assert.equal(constrainedPlan.achieved_targets.includes('TypeC'), true);
    assert.deepEqual(constrainedPlan.missing_inputs, []);
});

test('planWorkflowMulti disallowed_plugins excludes plugin-level matches', () => {
    const graph = new KnowledgeGraph(schema);
    const constrainedPlan = graph.planWorkflowMulti(['TypeA'], ['TypeC'], 4, {
        disallowed_plugins: ['planner', 'assembly'],
    });

    assert.equal(constrainedPlan.steps.some((step) => step.plugin === 'planner'), false);
    assert.equal(constrainedPlan.steps.some((step) => step.plugin === 'assembly'), false);
    assert.equal(constrainedPlan.steps.some((step) => step.plugin === 'taxa'), true);
    assert.equal(constrainedPlan.achieved_targets.includes('TypeC'), true);
    assert.deepEqual(constrainedPlan.missing_inputs, []);
});

test('planWorkflowMulti required_plugins prioritizes requested plugins', () => {
    const graph = new KnowledgeGraph(schema);
    const constrainedPlan = graph.planWorkflowMulti(['TypeA'], ['TypeC'], 4, {
        required_plugins: ['taxa'],
    });

    assert.equal(constrainedPlan.steps.some((step) => step.plugin === 'taxa'), true);
    assert.equal(constrainedPlan.achieved_targets.includes('TypeC'), true);
    assert.equal(
        constrainedPlan.warnings.some((warning) => warning.includes('Required plugins were not included')),
        false
    );
});

test('planWorkflowMulti required_plugins warns when unsatisfied', () => {
    const graph = new KnowledgeGraph(schema);
    const constrainedPlan = graph.planWorkflowMulti(['TypeA'], ['TypeTarget'], 4, {
        required_plugins: ['taxa'],
    });

    assert.equal(constrainedPlan.achieved_targets.includes('TypeTarget'), true);
    assert.equal(
        constrainedPlan.warnings.some((warning) => warning.includes('Required plugins were not included in the final plan: taxa.')),
        true
    );
});

test('findWorkflow keeps schema traversal order instead of lexicographic action order', () => {
    const traversalSchema: Schema = {
        plugins: {
            zzz: {
                actions: {
                    direct: {
                        description: 'Direct path declared first in schema order.',
                        inputs: {
                            source: { type: ['SourceType'], required: true },
                        },
                        parameters: {},
                        outputs: {
                            result: { type: ['TargetType'] },
                        },
                    },
                },
            },
            aaa: {
                actions: {
                    via_mid: {
                        description: 'Indirect path that is lexicographically earlier.',
                        inputs: {
                            mid: { type: ['MidType'], required: true },
                        },
                        parameters: {},
                        outputs: {
                            result: { type: ['TargetType'] },
                        },
                    },
                    make_mid: {
                        description: 'Generate MidType from SourceType.',
                        inputs: {
                            source: { type: ['SourceType'], required: true },
                        },
                        parameters: {},
                        outputs: {
                            mid: { type: ['MidType'] },
                        },
                    },
                },
            },
        },
        distributions: {
            test: {
                plugins: ['zzz', 'aaa'],
            },
        },
        types: {},
    };

    const graph = new KnowledgeGraph(traversalSchema);
    const workflow = graph.findWorkflow('SourceType', 'TargetType', 4);

    assert.notEqual(workflow, null);
    assert.equal(workflow!.length, 1);
    assert.equal(workflow![0].action_id, 'zzz:direct');
});
