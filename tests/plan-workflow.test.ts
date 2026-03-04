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
                refine: {
                    description: 'Refine TypeC into TypeD.',
                    inputs: {
                        raw: { type: ['TypeC'], required: true },
                    },
                    parameters: {},
                    outputs: {
                        refined: { type: ['TypeD'] },
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
        classifier: {
            actions: {
                classify_items: {
                    description: 'Classify items producing variant reports based on input type.',
                    inputs: {
                        items: { type: ['TypeA', 'TypeB'], required: true },
                    },
                    parameters: {},
                    outputs: {
                        report: { type: ['TypeReport_A', 'TypeReport_B'] },
                    },
                },
            },
        },
    },
    distributions: {
        test: {
            plugins: ['planner', 'taxa', 'assembly', 'classifier'],
        },
        only_taxa: {
            plugins: ['taxa'],
        },
    },
    types: {},
};

test('planWorkflow returns empty plan when target is already available', () => {
    const graph = new KnowledgeGraph(schema);
    const plan = graph.planWorkflow(['TypeA'], ['TypeA']);

    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.achieved_targets, ['TypeA']);
    assert.deepEqual(plan.missing_inputs, []);
    assert.deepEqual(plan.warnings, []);
});

test('planWorkflow finds a single-step path', () => {
    const graph = new KnowledgeGraph(schema);
    const plan = graph.planWorkflow(['TypeA'], ['TypeTarget']);

    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].action_id, 'planner:convert');
    assert.equal(plan.steps[0].output_type, 'TypeTarget');
    assert.deepEqual(plan.achieved_targets, ['TypeTarget']);
    assert.deepEqual(plan.missing_inputs, []);
});

test('planWorkflow finds a multi-step path through intermediate types', () => {
    const graph = new KnowledgeGraph(schema);
    // TypeA → derive_b → TypeB, then TypeA + TypeB → combine → TypeC
    const plan = graph.planWorkflow(['TypeA'], ['TypeC']);
    const actionIds = plan.steps.map((s) => s.action_id);

    assert.deepEqual(plan.achieved_targets, ['TypeC']);
    assert.deepEqual(plan.missing_inputs, []);
    // Must include a step that produces TypeC
    assert.ok(
        plan.steps.some((s) => s.output_type === 'TypeC'),
        'Should include a step producing TypeC'
    );
});

test('planWorkflow finds a three-step path', () => {
    const graph = new KnowledgeGraph(schema);
    // TypeA → derive_b → TypeB, TypeA+TypeB → combine → TypeC, TypeC → refine → TypeD
    const plan = graph.planWorkflow(['TypeA'], ['TypeD']);
    const actionIds = plan.steps.map((s) => s.action_id);

    assert.deepEqual(plan.achieved_targets, ['TypeD']);
    assert.deepEqual(plan.missing_inputs, []);
    assert.ok(actionIds.includes('planner:refine'), 'Should include refine step');
    // refine requires TypeC, which requires derive_b + combine (or taxa:profile)
    assert.ok(plan.steps.length >= 2, 'Should have at least 2 steps');
});

test('planWorkflow reports unreachable targets', () => {
    const graph = new KnowledgeGraph(schema);
    const plan = graph.planWorkflow(['TypeA'], ['TypeNonexistent']);

    assert.deepEqual(plan.achieved_targets, []);
    assert.deepEqual(plan.missing_inputs, ['TypeNonexistent']);
    assert.ok(plan.warnings.length > 0);
});

test('planWorkflow handles multiple targets', () => {
    const graph = new KnowledgeGraph(schema);
    const plan = graph.planWorkflow(['TypeA'], ['TypeTarget', 'TypeB']);

    assert.deepEqual(plan.achieved_targets.sort(), ['TypeB', 'TypeTarget']);
    assert.deepEqual(plan.missing_inputs, []);
    const actionIds = plan.steps.map((s) => s.action_id);
    assert.ok(actionIds.includes('planner:convert'));
    assert.ok(actionIds.includes('planner:derive_b'));
});

test('planWorkflow handles mix of achievable and unreachable targets', () => {
    const graph = new KnowledgeGraph(schema);
    const plan = graph.planWorkflow(['TypeA'], ['TypeTarget', 'TypeNonexistent']);

    assert.deepEqual(plan.achieved_targets, ['TypeTarget']);
    assert.deepEqual(plan.missing_inputs, ['TypeNonexistent']);
    assert.ok(plan.warnings.length > 0);
});

test('planWorkflow respects distribution filter', () => {
    const graph = new KnowledgeGraph(schema);
    // only_taxa distribution only has taxa plugin, which can do TypeA → TypeC via profile
    const plan = graph.planWorkflow(['TypeA'], ['TypeC'], { distribution: 'only_taxa' });

    assert.deepEqual(plan.achieved_targets, ['TypeC']);
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].action_id, 'taxa:profile');
});

test('planWorkflow respects max_depth limit', () => {
    const graph = new KnowledgeGraph(schema);
    // With maxDepth=1, we can discover actions at depth 0 only
    // derive_b runs at depth 0 (input TypeA available), producing TypeB
    // combine needs TypeA+TypeB, both available after depth 0 → runs at depth 1
    // refine needs TypeC → runs at depth 2
    // So maxDepth=1 should NOT reach TypeD
    const plan = graph.planWorkflow(['TypeA'], ['TypeD'], { maxDepth: 1 });

    assert.deepEqual(plan.missing_inputs, ['TypeD']);
});

test('planWorkflow steps are in topological order', () => {
    const graph = new KnowledgeGraph(schema);
    const plan = graph.planWorkflow(['TypeA'], ['TypeD']);

    // Each step should only depend on types available from earlier steps or from inputs
    const available = new Set(['TypeA']);
    for (const step of plan.steps) {
        const action = graph.getAction(step.plugin, step.action);
        assert.ok(action, `Action ${step.action_id} should exist`);

        for (const inputDef of Object.values(action!.inputs)) {
            if (!inputDef.required) continue;
            const inputTypes = Array.isArray(inputDef.type) ? inputDef.type : [inputDef.type];
            const satisfied = inputTypes.some((t: string) =>
                [...available].some((a) => graph.checkCompatibility(a, t))
            );
            assert.ok(satisfied, `Step ${step.action_id} input should be satisfied by prior steps`);
        }

        // Add outputs of this step
        if (action!.outputs) {
            for (const outputDef of Object.values(action!.outputs)) {
                const types = Array.isArray(outputDef.type) ? outputDef.type : [outputDef.type];
                for (const t of types) available.add(t);
            }
        }
    }
});

test('planWorkflow available_types includes all outputs from plan steps', () => {
    const graph = new KnowledgeGraph(schema);
    const plan = graph.planWorkflow(['TypeA'], ['TypeD']);

    assert.ok(plan.available_types.includes('TypeA'), 'Should include starting type');
    assert.ok(plan.available_types.includes('TypeD'), 'Should include target type');
});

test('planWorkflow returns empty steps and warnings for empty inputs', () => {
    const graph = new KnowledgeGraph(schema);
    const plan = graph.planWorkflow([], ['TypeTarget']);

    assert.deepEqual(plan.steps, []);
    assert.ok(plan.warnings.length > 0);
});

test('planWorkflow throws for unknown distribution', () => {
    const graph = new KnowledgeGraph(schema);
    assert.throws(
        () => graph.planWorkflow(['TypeA'], ['TypeC'], { distribution: 'nonexistent' }),
        /Distribution 'nonexistent' not found/
    );
});

test('planWorkflow uses type compatibility, not just exact string matching', () => {
    const compatSchema: Schema = {
        plugins: {
            indexer: {
                actions: {
                    build_index: {
                        description: 'Build an index.',
                        inputs: {
                            contigs: { type: ['SampleData[Contigs]'], required: true },
                        },
                        parameters: {},
                        outputs: {
                            index: { type: ["SampleData[SingleBowtie2Index % Properties('contigs')]"] },
                        },
                    },
                    use_index: {
                        description: 'Use an index with contigs property.',
                        inputs: {
                            index: {
                                type: ["SampleData[SingleBowtie2Index % Properties('contigs')]"],
                                required: true,
                            },
                        },
                        parameters: {},
                        outputs: {
                            result: { type: ['TypeResult'] },
                        },
                    },
                },
            },
        },
        distributions: {},
        types: {},
    };
    const graph = new KnowledgeGraph(compatSchema);
    const plan = graph.planWorkflow(['SampleData[Contigs]'], ['TypeResult']);

    assert.deepEqual(plan.achieved_targets, ['TypeResult']);
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[0].action_id, 'indexer:build_index');
    assert.equal(plan.steps[1].action_id, 'indexer:use_index');
});

test('planWorkflow exclude_plugins removes plugins from consideration', () => {
    const graph = new KnowledgeGraph(schema);
    // Without exclusion, taxa:profile provides a single-step path to TypeC
    // Excluding taxa forces the planner to go through derive_b + combine
    const plan = graph.planWorkflow(['TypeA'], ['TypeC'], { excludePlugins: ['taxa'] });

    assert.deepEqual(plan.achieved_targets, ['TypeC']);
    const actionIds = plan.steps.map((s) => s.action_id);
    assert.ok(!actionIds.includes('taxa:profile'), 'taxa:profile should be excluded');
    assert.ok(actionIds.includes('planner:derive_b'), 'Should use derive_b for TypeB');
    assert.ok(
        actionIds.includes('planner:combine') || actionIds.includes('assembly:assemble_c'),
        'Should use combine or assemble_c for TypeC'
    );
});

test('planWorkflow exclude_plugins can make targets unreachable', () => {
    const graph = new KnowledgeGraph(schema);
    // Exclude all plugins that can produce TypeTarget (only planner:convert does)
    const plan = graph.planWorkflow(['TypeA'], ['TypeTarget'], { excludePlugins: ['planner'] });

    assert.deepEqual(plan.achieved_targets, []);
    assert.deepEqual(plan.missing_inputs, ['TypeTarget']);
});

test('planWorkflow include_plugins prefers listed plugins', () => {
    const graph = new KnowledgeGraph(schema);
    // Prefer taxa plugin — taxa:profile can do TypeA → TypeC in one step
    const plan = graph.planWorkflow(['TypeA'], ['TypeC'], { includePlugins: ['taxa'] });

    assert.deepEqual(plan.achieved_targets, ['TypeC']);
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].action_id, 'taxa:profile');
});

test('planWorkflow include_plugins pulls in dependency plugins when needed', () => {
    const graph = new KnowledgeGraph(schema);
    // Prefer assembly — it needs TypeA + TypeB, TypeB can only come from planner:derive_b
    // The planner dependency should still be pulled in to satisfy the requirement
    const plan = graph.planWorkflow(['TypeA'], ['TypeC'], { includePlugins: ['assembly'] });

    assert.deepEqual(plan.achieved_targets, ['TypeC']);
    const actionIds = plan.steps.map((s) => s.action_id);
    assert.ok(actionIds.includes('assembly:assemble_c'), 'Should prefer assembly:assemble_c');
    assert.ok(actionIds.includes('planner:derive_b'), 'Should pull in planner:derive_b as dependency');
});

test('planWorkflow include and exclude can be combined', () => {
    const graph = new KnowledgeGraph(schema);
    // Prefer planner and taxa, but exclude taxa from BFS
    // Result: taxa actions not available, planner actions preferred
    const plan = graph.planWorkflow(['TypeA'], ['TypeC'], {
        includePlugins: ['planner', 'taxa'],
        excludePlugins: ['taxa'],
    });

    assert.deepEqual(plan.achieved_targets, ['TypeC']);
    const actionIds = plan.steps.map((s) => s.action_id);
    assert.ok(!actionIds.some((id) => id.startsWith('taxa:')), 'No taxa actions');
    assert.ok(actionIds.includes('planner:combine'), 'Should use planner:combine');
});

test('planWorkflow throws for unknown plugin in exclude_plugins', () => {
    const graph = new KnowledgeGraph(schema);
    assert.throws(
        () => graph.planWorkflow(['TypeA'], ['TypeC'], { excludePlugins: ['nonexistent'] }),
        /Plugin 'nonexistent' not found/
    );
});

test('planWorkflow throws for unknown plugin in include_plugins', () => {
    const graph = new KnowledgeGraph(schema);
    assert.throws(
        () => graph.planWorkflow(['TypeA'], ['TypeC'], { includePlugins: ['nonexistent'] }),
        /Plugin 'nonexistent' not found/
    );
});

test('planWorkflow produces separate steps for union-typed output port variants', () => {
    const graph = new KnowledgeGraph(schema);
    // classifier:classify_items has a single output port with union types
    // [TypeReport_A, TypeReport_B]. Requesting both should produce two invocations.
    const plan = graph.planWorkflow(['TypeA'], ['TypeReport_A', 'TypeReport_B']);

    assert.deepEqual(plan.achieved_targets.sort(), ['TypeReport_A', 'TypeReport_B']);
    assert.deepEqual(plan.missing_inputs, []);

    const classifySteps = plan.steps.filter((s) => s.action_id === 'classifier:classify_items');
    assert.equal(classifySteps.length, 2, 'Should have two invocations of classify_items');
    const outputTypes = classifySteps.map((s) => s.output_type).sort();
    assert.deepEqual(outputTypes, ['TypeReport_A', 'TypeReport_B']);
});

test('planWorkflow reuses action for free when output is from a different port', () => {
    // An action with two output ports — both are produced in a single invocation
    const multiPortSchema: Schema = {
        plugins: {
            processor: {
                actions: {
                    process: {
                        description: 'Process input producing two distinct outputs.',
                        inputs: {
                            source: { type: ['TypeInput'], required: true },
                        },
                        parameters: {},
                        outputs: {
                            primary: { type: ['TypePrimary'] },
                            secondary: { type: ['TypeSecondary'] },
                        },
                    },
                },
            },
        },
        distributions: {},
        types: {},
    };
    const graph = new KnowledgeGraph(multiPortSchema);
    const plan = graph.planWorkflow(['TypeInput'], ['TypePrimary', 'TypeSecondary']);

    assert.deepEqual(plan.achieved_targets.sort(), ['TypePrimary', 'TypeSecondary']);
    // Only ONE step needed — both outputs come from different ports of the same action
    const processSteps = plan.steps.filter((s) => s.action_id === 'processor:process');
    assert.equal(processSteps.length, 1, 'Should have only one invocation of process');
});
