import { strict as assert } from "node:assert";
import { test } from "node:test";
import { registerRachisTools } from "../src/tool-registry.js";

interface ToolRegistration {
	description?: string;
	params?: unknown;
	annotations?: unknown;
	handler: (...args: any[]) => Promise<any> | any;
}

const registerTools = async () => {
	const tools = new Map<string, ToolRegistration>();
	const fakeServer = {
		tool: (...args: any[]) => {
			const [name, ...rest] = args;
			let description: string | undefined;
			let params: unknown;
			let annotations: unknown;
			let handler: ToolRegistration["handler"] | undefined;

			if (typeof rest[0] === "function") {
				handler = rest[0];
			} else if (typeof rest[1] === "function") {
				if (typeof rest[0] === "string") {
					description = rest[0];
				} else {
					params = rest[0];
				}
				handler = rest[1];
			} else if (typeof rest[2] === "function") {
				description = typeof rest[0] === "string" ? rest[0] : undefined;
				if (
					typeof rest[1] === "object" &&
					rest[1] !== null &&
					!("safeParse" in (rest[1] as object))
				) {
					params = undefined;
					annotations = rest[1];
				} else {
					params = rest[1];
				}
				handler = rest[2];
			} else if (typeof rest[3] === "function") {
				description = typeof rest[0] === "string" ? rest[0] : undefined;
				params = rest[1];
				annotations = rest[2];
				handler = rest[3];
			}

			if (!handler) {
				throw new Error(`Failed to capture tool registration for ${String(name)}`);
			}
			tools.set(name, { description, params, annotations, handler });
			return {};
		},
	};

	registerRachisTools(fakeServer);
	return tools;
};

const parseJsonText = (result: { content: Array<{ text: string }> }) =>
	JSON.parse(result.content[0].text);

const expectedReadOnlyAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

test("RachisMCP registers the expected tool surface", async () => {
	const tools = await registerTools();

	assert.deepEqual([...tools.keys()].sort(), [
		"compare_versions",
		"find_compatible_actions",
		"find_consumers",
		"find_input_type_candidates",
		"find_producers",
		"get_action_details",
		"get_type_details",
		"list_actions",
		"list_distributions",
		"list_plugins",
		"list_schema_versions",
		"list_semantic_types",
	]);
});

test("RachisMCP registers read-only closed-world annotations for exposed tools", async () => {
	const tools = await registerTools();

	for (const registration of tools.values()) {
		assert.deepEqual(registration.annotations, expectedReadOnlyAnnotations);
	}
});

test("list_distributions and list_plugins return schema-backed results", async () => {
	const tools = await registerTools();
	const listDistributions = tools.get("list_distributions")!;
	const listPlugins = tools.get("list_plugins")!;

	const distributions = parseJsonText(await listDistributions.handler({ version: "2025.4" }));
	const plugins = parseJsonText(
		await listPlugins.handler({ distribution: "amplicon", version: "2025.4" }),
	);

	assert.equal(Array.isArray(distributions), true);
	assert.deepEqual(distributions.sort(), ["amplicon", "moshpit", "pathogenome"]);
	assert.equal(Array.isArray(plugins), true);
	assert.equal(plugins.includes("feature-classifier"), true);
});

test("list_semantic_types returns sorted canonical types and honors distribution/version filters", async () => {
	const tools = await registerTools();
	const listSemanticTypes = tools.get("list_semantic_types")!;

	const allTypes = parseJsonText(await listSemanticTypes.handler({ version: "2025.4" }));
	assert.equal(Array.isArray(allTypes), true);
	assert.equal(
		allTypes.some((typeInfo: any) => typeInfo.type_name === "FeatureData[Sequence]"),
		true,
	);
	assert.deepEqual(
		[...allTypes]
			.map((typeInfo: any) => typeInfo.type_name)
			.sort((left: string, right: string) => left.localeCompare(right)),
		allTypes.map((typeInfo: any) => typeInfo.type_name),
	);

	const quastResults = allTypes.find((typeInfo: any) => typeInfo.type_name === "QUASTResults");
	assert.equal(quastResults.origin_plugin, "assembly");
	assert.equal(Object.prototype.hasOwnProperty.call(quastResults, "description"), true);
	assert.equal(quastResults.description, null);

	const classifierType = allTypes.find(
		(typeInfo: any) => typeInfo.type_name === "TaxonomicClassifier",
	);
	assert.equal(classifierType.origin_plugin, "feature-classifier");

	const pathogenomeTypes = parseJsonText(
		await listSemanticTypes.handler({ distribution: "pathogenome", version: "2025.4" }),
	);
	assert.equal(Array.isArray(pathogenomeTypes), true);
	assert.equal(
		pathogenomeTypes.some((typeInfo: any) => typeInfo.type_name === "FeatureData[Contig]"),
		true,
	);
	assert.equal(
		pathogenomeTypes.some((typeInfo: any) => typeInfo.type_name === "FeatureData[Sequence]"),
		true,
	);

	const ampliconTypes = parseJsonText(
		await listSemanticTypes.handler({ distribution: "amplicon", version: "2025.4" }),
	);
	assert.equal(Array.isArray(ampliconTypes), true);
	assert.equal(
		ampliconTypes.some((typeInfo: any) => typeInfo.type_name === "FeatureData[Contig]"),
		false,
	);
	assert.equal(
		ampliconTypes.some((typeInfo: any) => typeInfo.type_name === "FeatureData[Sequence]"),
		true,
	);

	const olderTypes = parseJsonText(await listSemanticTypes.handler({ version: "2025.4" }));
	assert.equal(Array.isArray(olderTypes), true);
	assert.equal(
		olderTypes.some((typeInfo: any) => typeInfo.type_name === "FeatureMap[FunctionToContigs]"),
		false,
	);

	const errorResult = parseJsonText(
		await listSemanticTypes.handler({
			distribution: "missing_distribution",
			version: "2025.4",
		}),
	);
	assert.match(errorResult.error, /Distribution 'missing_distribution' not found/);
});

test("get_type_details and get_action_details expose descriptions and missing-item errors", async () => {
	const tools = await registerTools();
	const getTypeDetails = tools.get("get_type_details")!;
	const getActionDetails = tools.get("get_action_details")!;

	const typeResult = await getTypeDetails.handler({ type_name: "FeatureData[Sequence]" });
	assert.match(typeResult.content[0].text, /Unaligned DNA sequences/);

	const missingType = parseJsonText(
		await getTypeDetails.handler({ type_name: "TypeThatDoesNotExist" }),
	);
	assert.match(missingType.error, /Type 'TypeThatDoesNotExist' not found/);

	const actionResult = parseJsonText(
		await getActionDetails.handler({
			plugin_name: "feature_classifier",
			action_name: "classify-sklearn",
		}),
	);
	assert.equal(actionResult.description, "Classify reads by taxon using a fitted classifier.");
	assert.equal(actionResult.inputs.reads.type[0], "FeatureData[Sequence]");

	const missingAction = parseJsonText(
		await getActionDetails.handler({
			plugin_name: "feature-classifier",
			action_name: "missing_action",
		}),
	);
	assert.match(missingAction.error, /Action 'feature-classifier:missing-action' not found/);
});

test("find_compatible_actions wraps filter errors and returns sorted action ids", async () => {
	const tools = await registerTools();
	const findCompatibleActions = tools.get("find_compatible_actions")!;

	const compatible = parseJsonText(
		await findCompatibleActions.handler({
			semantic_type: "FeatureData[Sequence]",
			plugin: "feature-classifier",
		}),
	);
	assert.equal(Array.isArray(compatible), true);
	assert.equal(compatible.includes("feature-classifier:classify-sklearn"), true);
	assert.deepEqual([...compatible].sort(), compatible);

	const errorResult = parseJsonText(
		await findCompatibleActions.handler({
			semantic_type: "FeatureData[Sequence]",
			distribution: "missing_distribution",
		}),
	);
	assert.match(errorResult.error, /Distribution 'missing_distribution' not found/);
});

test("find_input_type_candidates returns structured candidate payloads", async () => {
	const tools = await registerTools();
	const findInputTypeCandidates = tools.get("find_input_type_candidates")!;

	const result = parseJsonText(
		await findInputTypeCandidates.handler({
			kind: "reads",
			distribution: "amplicon",
			version: "2025.4",
			limit: 3,
		}),
	);

	assert.equal(result.kind, "reads");
	assert.equal(Array.isArray(result.candidates), true);
	assert.equal(result.candidates.length <= 3, true);
	assert.equal(result.candidates.length > 0, true);
	assert.equal(typeof result.candidates[0].semantic_type, "string");
	assert.equal(Array.isArray(result.candidates[0].consumers), true);
	assert.equal(Array.isArray(result.candidates[0].match_sources), true);
});

test("find_consumers and find_producers expose normalized action id arrays", async () => {
	const tools = await registerTools();
	const findConsumers = tools.get("find_consumers")!;
	const findProducers = tools.get("find_producers")!;

	const consumers = parseJsonText(
		await findConsumers.handler({
			types: ["FeatureData[Sequence]"],
			plugin: "feature_classifier",
		}),
	);
	assert.equal(Array.isArray(consumers), true);
	assert.equal(consumers.includes("feature-classifier:extract-reads"), true);
	assert.deepEqual([...consumers].sort(), consumers);

	const producers = parseJsonText(
		await findProducers.handler({
			types: ["FeatureData[Taxonomy]"],
			plugin: "feature-classifier",
		}),
	);
	assert.equal(Array.isArray(producers), true);
	assert.equal(producers.includes("feature-classifier:classify-sklearn"), true);
	assert.deepEqual([...producers].sort(), producers);
});

test("list_actions returns sorted unique action IDs and handles filtering", async () => {
	const tools = await registerTools();
	const listActions = tools.get("list_actions")!;

	const actions = parseJsonText(
		await listActions.handler({
			distribution: "amplicon",
			version: "2025.4",
		}),
	);
	assert.equal(Array.isArray(actions), true);
	assert.equal(actions.includes("feature-classifier:classify-sklearn"), true);
	assert.deepEqual([...actions].sort(), actions);

	const filteredActions = parseJsonText(
		await listActions.handler({
			distribution: "amplicon",
			plugin: "feature-classifier",
			version: "2025.4",
		}),
	);
	assert.equal(Array.isArray(filteredActions), true);
	assert.equal(filteredActions.includes("feature-classifier:classify-sklearn"), true);
	assert.equal(
		filteredActions.every((a: string) => a.startsWith("feature-classifier:")),
		true,
	);

	const errorResult = parseJsonText(
		await listActions.handler({
			distribution: "missing_distribution",
			version: "2025.4",
		}),
	);
	assert.match(errorResult.error, /Distribution 'missing_distribution' not found/);
});
