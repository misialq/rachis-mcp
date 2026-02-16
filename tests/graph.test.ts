import { strict as assert } from "node:assert";
import { test } from "node:test";
import { KnowledgeGraph } from "../src/graph.js";
import type { Schema } from "../src/types.js";

const schema: Schema = {
	plugins: {
		planner: {
			actions: {
				combine: {
					description: "Combine two required inputs.",
					inputs: {
						left: { type: ["TypeA"], required: true },
						right: { type: ["TypeB"], required: true },
					},
					parameters: {},
					outputs: {
						combined: { type: ["TypeC"] },
					},
				},
				convert: {
					description: "Convert TypeA to TypeTarget.",
					inputs: {
						source: { type: ["TypeA"], required: true },
					},
					parameters: {},
					outputs: {
						target: { type: ["TypeTarget"] },
					},
				},
				property_consumer: {
					description: "Consume index data with contigs property.",
					inputs: {
						index: {
							type: ["SampleData[SingleBowtie2Index % Properties('contigs')]"],
							required: true,
						},
					},
					parameters: {},
					outputs: {
						result: { type: ["TypeIndexed"] },
					},
				},
			},
		},
	},
	distributions: {
		test: {
			plugins: ["planner"],
		},
	},
};

const toActionIds = (actions: { plugin: string; action: string }[]) =>
	actions.map(({ plugin, action }) => `${plugin}:${action}`);

test("findConsumers required_inputs enforces all required inputs", () => {
	const graph = new KnowledgeGraph(schema);

	const partial = toActionIds(graph.findConsumers(["TypeA"], "required_inputs"));
	assert.equal(partial.includes("planner:combine"), false);

	const full = toActionIds(graph.findConsumers(["TypeA", "TypeB"], "required_inputs"));
	assert.equal(full.includes("planner:combine"), true);
});

test("findConsumers strict_consumption rejects extra unmatched input types", () => {
	const graph = new KnowledgeGraph(schema);

	const requiredMode = toActionIds(
		graph.findConsumers(["TypeA", "TypeB", "TypeZ"], "required_inputs"),
	);
	const strictMode = toActionIds(
		graph.findConsumers(["TypeA", "TypeB", "TypeZ"], "strict_consumption"),
	);

	assert.equal(requiredMode.includes("planner:combine"), true);
	assert.equal(strictMode.includes("planner:combine"), false);
});

test("findConsumers uses compatibility checks instead of exact matching", () => {
	const graph = new KnowledgeGraph(schema);
	const consumers = toActionIds(
		graph.findConsumers(
			["SampleData[SingleBowtie2Index % Properties('mags', 'contigs')]"],
			"required_inputs",
		),
	);

	assert.equal(consumers.includes("planner:property_consumer"), true);
});

test("findWorkflow step includes backward-compatible fields and action_id", () => {
	const graph = new KnowledgeGraph(schema);
	const workflow = graph.findWorkflow("TypeA", "TypeTarget", 3);

	assert.notEqual(workflow, null);
	assert.equal(workflow!.length > 0, true);
	assert.equal(workflow![0].plugin, "planner");
	assert.equal(workflow![0].action, "convert");
	assert.equal(workflow![0].action_id, "planner:convert");
	assert.equal(workflow![0].output_type, "TypeTarget");
});
