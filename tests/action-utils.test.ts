import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeActionIds } from "../src/action-utils.js";

test("normalizeActionIds returns sorted unique action IDs", () => {
	const normalized = normalizeActionIds([
		"feature:classify",
		"assembly:assemble",
		"feature:classify",
		"annotate:align",
	]);

	assert.deepEqual(normalized, ["annotate:align", "assembly:assemble", "feature:classify"]);
});
