import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { registerRachisTools } from '../src/tool-registry.js';

interface ToolRegistration {
    description?: string;
    params?: unknown;
    handler: (...args: any[]) => Promise<any> | any;
}

const registerTools = async () => {
    const tools = new Map<string, ToolRegistration>();
    const fakeServer = {
        tool: (...args: any[]) => {
            const [name, ...rest] = args;
            let description: string | undefined;
            let params: unknown;
            let handler: ToolRegistration['handler'] | undefined;

            if (typeof rest[0] === 'function') {
                handler = rest[0];
            } else if (typeof rest[1] === 'function') {
                if (typeof rest[0] === 'string') {
                    description = rest[0];
                } else {
                    params = rest[0];
                }
                handler = rest[1];
            } else if (typeof rest[2] === 'function') {
                description = typeof rest[0] === 'string' ? rest[0] : undefined;
                params = rest[1];
                handler = rest[2];
            } else if (typeof rest[3] === 'function') {
                description = typeof rest[0] === 'string' ? rest[0] : undefined;
                params = rest[1];
                handler = rest[3];
            }

            if (!handler) {
                throw new Error(`Failed to capture tool registration for ${String(name)}`);
            }

            tools.set(name, { description, params, handler });
            return {};
        },
    };

    registerRachisTools(fakeServer);
    return tools;
};

const parseJsonText = (result: { content: Array<{ text: string }> }) =>
    JSON.parse(result.content[0].text);

test('RachisMCP registers the expected tool surface', async () => {
    const tools = await registerTools();

    assert.deepEqual([...tools.keys()].sort(), [
        'find_compatible_actions',
        'find_consumers',
        'find_input_type_candidates',
        'find_producers',
        'get_action_details',
        'get_type_details',
        'list_available_plugins',
        'list_distributions',
        'list_schema_versions',
        'plan_workflow',
    ]);
});

test('list_distributions and list_available_plugins return schema-backed results', async () => {
    const tools = await registerTools();
    const listDistributions = tools.get('list_distributions')!;
    const listPlugins = tools.get('list_available_plugins')!;

    const distributions = parseJsonText(await listDistributions.handler({}));
    const plugins = parseJsonText(await listPlugins.handler({ distribution: 'amplicon' }));

    assert.equal(Array.isArray(distributions), true);
    assert.deepEqual(distributions.sort(), ['amplicon', 'moshpit', 'pathogenome']);
    assert.equal(Array.isArray(plugins), true);
    assert.equal(plugins.includes('feature-classifier'), true);
});

test('get_type_details and get_action_details expose descriptions and missing-item errors', async () => {
    const tools = await registerTools();
    const getTypeDetails = tools.get('get_type_details')!;
    const getActionDetails = tools.get('get_action_details')!;

    const typeResult = await getTypeDetails.handler({ type_name: 'FeatureData[Sequence]' });
    assert.match(typeResult.content[0].text, /Unaligned DNA sequences/);

    const missingType = parseJsonText(await getTypeDetails.handler({ type_name: 'TypeThatDoesNotExist' }));
    assert.match(missingType.error, /Type 'TypeThatDoesNotExist' not found/);

    const actionResult = parseJsonText(await getActionDetails.handler({
        plugin_name: 'feature-classifier',
        action_name: 'classify_sklearn',
    }));
    assert.equal(actionResult.description, 'Classify reads by taxon using a fitted classifier.');
    assert.equal(actionResult.inputs.reads.type[0], 'FeatureData[Sequence]');

    const missingAction = parseJsonText(await getActionDetails.handler({
        plugin_name: 'feature-classifier',
        action_name: 'missing_action',
    }));
    assert.match(missingAction.error, /Action 'feature-classifier:missing_action' not found/);
});

test('find_compatible_actions wraps filter errors and returns sorted action ids', async () => {
    const tools = await registerTools();
    const findCompatibleActions = tools.get('find_compatible_actions')!;

    const compatible = parseJsonText(await findCompatibleActions.handler({
        semantic_type: 'FeatureData[Sequence]',
        plugin: 'feature-classifier',
    }));
    assert.equal(Array.isArray(compatible), true);
    assert.equal(compatible.includes('feature-classifier:classify_sklearn'), true);
    assert.deepEqual([...compatible].sort(), compatible);

    const errorResult = parseJsonText(await findCompatibleActions.handler({
        semantic_type: 'FeatureData[Sequence]',
        distribution: 'missing_distribution',
    }));
    assert.match(errorResult.error, /Distribution 'missing_distribution' not found/);
});

test('find_input_type_candidates returns structured candidate payloads', async () => {
    const tools = await registerTools();
    const findInputTypeCandidates = tools.get('find_input_type_candidates')!;

    const result = parseJsonText(await findInputTypeCandidates.handler({
        kind: 'reads',
        distribution: 'amplicon',
        limit: 3,
    }));

    assert.equal(result.kind, 'reads');
    assert.equal(Array.isArray(result.candidates), true);
    assert.equal(result.candidates.length <= 3, true);
    assert.equal(result.candidates.length > 0, true);
    assert.equal(typeof result.candidates[0].semantic_type, 'string');
    assert.equal(Array.isArray(result.candidates[0].consumers), true);
    assert.equal(Array.isArray(result.candidates[0].match_sources), true);
});

test('find_consumers and find_producers expose normalized action id arrays', async () => {
    const tools = await registerTools();
    const findConsumers = tools.get('find_consumers')!;
    const findProducers = tools.get('find_producers')!;

    const consumers = parseJsonText(await findConsumers.handler({
        types: ['FeatureData[Sequence]'],
        plugin: 'feature-classifier',
    }));
    assert.equal(Array.isArray(consumers), true);
    assert.equal(consumers.includes('feature-classifier:extract_reads'), true);
    assert.deepEqual([...consumers].sort(), consumers);

    const producers = parseJsonText(await findProducers.handler({
        types: ['FeatureData[Taxonomy]'],
        plugin: 'feature-classifier',
    }));
    assert.equal(Array.isArray(producers), true);
    assert.equal(producers.includes('feature-classifier:classify_sklearn'), true);
    assert.deepEqual([...producers].sort(), producers);
});
