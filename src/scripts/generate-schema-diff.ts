import { readFileSync, writeFileSync } from "node:fs";
import { Schema } from "../types";

interface SchemaDiff {
	added_plugins: string[];
	added_actions: { plugin: string; action: string }[];
}

function generateDiff(oldSchemaPath: string, newSchemaPath: string, outputPath: string) {
	let oldSchema: Schema;
	try {
		oldSchema = JSON.parse(readFileSync(oldSchemaPath, "utf-8"));
    } catch (_e) {
		// If old schema file doesn't exist, assume empty schema
		console.warn(`Could not read old schema from ${oldSchemaPath}, assuming empty.`);
		oldSchema = { plugins: {}, distributions: {} };
	}

	const newSchema: Schema = JSON.parse(readFileSync(newSchemaPath, "utf-8"));

	const diff: SchemaDiff = {
		added_plugins: [],
		added_actions: [],
	};

	// Find added plugins
	for (const pluginName of Object.keys(newSchema.plugins)) {
		if (!oldSchema.plugins[pluginName]) {
			diff.added_plugins.push(pluginName);
		}
	}

	// Find added actions
	for (const [pluginName, plugin] of Object.entries(newSchema.plugins)) {
		const oldPlugin = oldSchema.plugins[pluginName];
		if (oldPlugin) {
			for (const actionName of Object.keys(plugin.actions)) {
				if (!oldPlugin.actions[actionName]) {
					diff.added_actions.push({ plugin: pluginName, action: actionName });
				}
			}
		} else {
			// New plugin: list all its actions as added
			for (const actionName of Object.keys(plugin.actions)) {
				diff.added_actions.push({ plugin: pluginName, action: actionName });
			}
		}
	}

	writeFileSync(outputPath, JSON.stringify(diff, null, 2));
	console.log(`Diff written to ${outputPath}`);
}

const args = process.argv.slice(2);
if (args.length !== 3) {
	console.error(
		"Usage: npx tsx src/scripts/generate-schema-diff.ts <old-schema.json> <new-schema.json> <output.json>",
	);
	process.exit(1);
}

generateDiff(args[0], args[1], args[2]);
