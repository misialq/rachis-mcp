import { z } from 'zod';
import { normalizeActionIds, toActionId } from './action-utils.js';
import { getGraph } from './graph-registry.js';
import { AVAILABLE_VERSIONS, LATEST_VERSION, getSchema } from './schema-registry.js';
import { diffSchemas } from './schema-diff.js';

const toMermaid = (
    steps: Array<{ step_id: number; action_id: string; output_type: string; depends_on: number[] }>
): string => {
    if (steps.length === 0) return 'flowchart LR';

    const stepById = new Map(steps.map((s) => [s.step_id, s]));

    // Collect all type strings that appear as node boxes
    const types = new Set<string>();
    for (const s of steps) {
        types.add(s.output_type);
        for (const dep of s.depends_on) {
            const pred = stepById.get(dep);
            if (pred) types.add(pred.output_type);
        }
    }

    // Assign stable short node IDs
    const typeToId = new Map<string, string>();
    let idx = 0;
    for (const t of types) typeToId.set(t, `t${idx++}`);

    const sanitize = (s: string) => s.replace(/"/g, "'");
    const fmtAction = (id: string) => {
        const [plugin, action] = id.split(':');
        return `${plugin}:${action.replaceAll('_', '-')}`;
    };

    const lines = ['flowchart LR'];

    // Type nodes (boxes)
    for (const [type, id] of typeToId) {
        lines.push(`    ${id}["${sanitize(type)}"]`);
    }

    // Action edges: predecessor_output_type -->|action| step_output_type
    for (const s of steps) {
        const outId = typeToId.get(s.output_type)!;
        const label = sanitize(fmtAction(s.action_id));
        for (const dep of s.depends_on) {
            const pred = stepById.get(dep);
            if (!pred) continue;
            const inId = typeToId.get(pred.output_type)!;
            lines.push(`    ${inId} -->|"${label}"| ${outId}`);
        }
    }

    return lines.join('\n');
};

export interface ToolRegistrar {
    tool: (...args: any[]) => unknown;
}

const versionParam = z
    .string()
    .optional()
    .describe(
        `QIIME 2 schema version to query (e.g. "${LATEST_VERSION}"). Omit to use the latest available.`
    );

export const registerRachisTools = (server: ToolRegistrar): void => {
    server.tool(
        'list_schema_versions',
        'Lists all available QIIME 2 schema versions and indicates which is the latest.',
        {},
        async () => {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ versions: AVAILABLE_VERSIONS, latest: LATEST_VERSION }, null, 2),
                    },
                ],
            };
        }
    );

    server.tool(
        'list_plugins',
        'Lists all available Rachis plugins. Optionally filter by distribution name.',
        {
            distribution: z.string().optional().describe('Optional distribution name to filter plugins'),
            version: versionParam,
        },
        async ({ distribution, version }: { distribution?: string; version?: string }) => {
            try {
                const { graph } = getGraph(version);
                const plugins = graph.getPlugins(distribution);
                return {
                    content: [{ type: 'text', text: JSON.stringify(plugins, null, 2) }],
                };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                };
            }
        }
    );

    server.tool(
        'list_distributions',
        'Lists all available Rachis distributions.',
        { version: versionParam },
        async ({ version }: { version?: string }) => {
            try {
                const { graph } = getGraph(version);
                const distributions = graph.getDistributions();
                return {
                    content: [{ type: 'text', text: JSON.stringify(distributions, null, 2) }],
                };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                };
            }
        }
    );

    server.tool(
        'list_semantic_types',
        'Lists all known Rachis semantic types. Optionally filter by distribution name.',
        {
            distribution: z.string().optional().describe('Optional distribution name to scope semantic types'),
            version: versionParam,
        },
        async ({ distribution, version }: { distribution?: string; version?: string }) => {
            try {
                const { graph } = getGraph(version);
                const semanticTypes = graph.listSemanticTypes({ distribution });
                return {
                    content: [{ type: 'text', text: JSON.stringify(semanticTypes, null, 2) }],
                };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                };
            }
        }
    );

    server.tool(
        'get_type_details',
        'Retrieves the description and details for a specific Rachis semantic type.',
        {
            type_name: z.string().describe('The name of the semantic type'),
            version: versionParam,
        },
        async ({ type_name, version }: { type_name: string; version?: string }) => {
            try {
                const { graph } = getGraph(version);
                const description = graph.getType(type_name);
                if (description === undefined) {
                    return {
                        content: [
                            { type: 'text', text: JSON.stringify({ error: `Type '${type_name}' not found.` }) },
                        ],
                    };
                }
                return {
                    content: [{ type: 'text', text: description || 'No description available.' }],
                };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                };
            }
        }
    );

    server.tool(
        'get_action_details',
        'Retrieves the details, inputs, outputs, and parameters for a specific Rachis plugin action.',
        {
            plugin_name: z.string().describe('The name of the plugin'),
            action_name: z.string().describe('The name of the action'),
            version: versionParam,
        },
        async ({
            plugin_name,
            action_name,
            version,
        }: {
            plugin_name: string;
            action_name: string;
            version?: string;
        }) => {
            try {
                const { graph } = getGraph(version);
                const action = graph.getAction(plugin_name, action_name);
                if (!action) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: `Action '${plugin_name}:${action_name}' not found.`,
                                }),
                            },
                        ],
                    };
                }
                return { content: [{ type: 'text', text: JSON.stringify(action, null, 2) }] };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                };
            }
        }
    );

    server.tool(
        'find_compatible_actions',
        'Finds all Rachis actions that accept the provided semantic type as an input.',
        {
            semantic_type: z.string().describe('The semantic type to find compatible actions for'),
            distribution: z.string().optional().describe('Optional distribution name to scope the search'),
            plugin: z.string().optional().describe('Optional plugin name to scope the search'),
            version: versionParam,
        },
        async ({
            semantic_type,
            distribution,
            plugin,
            version,
        }: {
            semantic_type: string;
            distribution?: string;
            plugin?: string;
            version?: string;
        }) => {
            try {
                const { graph } = getGraph(version);
                const compatible = graph.findCompatibleActions(semantic_type, { distribution, plugin });
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                normalizeActionIds(
                                    compatible.map(({ plugin, action }) => toActionId(plugin, action))
                                ),
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                };
            }
        }
    );

    server.tool(
        'find_input_type_candidates',
        "Maps a free-text description of an input kind (for example 'reads' or 'contigs') to likely semantic types and the actions that can consume them.",
        {
            kind: z.string().describe('Free-text description of the input kind to resolve'),
            distribution: z.string().optional().describe('Optional distribution name to scope candidate discovery'),
            plugin: z.string().optional().describe('Optional plugin name to scope candidate discovery'),
            limit: z
                .number()
                .int()
                .min(1)
                .max(25)
                .optional()
                .default(10)
                .describe('Maximum number of candidate semantic types to return'),
            version: versionParam,
        },
        async ({
            kind,
            distribution,
            plugin,
            limit,
            version,
        }: {
            kind: string;
            distribution?: string;
            plugin?: string;
            limit: number;
            version?: string;
        }) => {
            try {
                const { graph } = getGraph(version);
                const candidates = graph.findInputTypeCandidates(kind, { distribution, plugin, limit });
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    kind,
                                    candidates: candidates.map((candidate) => ({
                                        semantic_type: candidate.semantic_type,
                                        description: candidate.description,
                                        score: candidate.score,
                                        match_sources: candidate.match_sources,
                                        matched_terms: candidate.matched_terms,
                                        common_input_names: candidate.common_input_names,
                                        consumers: normalizeActionIds(
                                            candidate.consumers.map(({ plugin, action }) =>
                                                toActionId(plugin, action)
                                            )
                                        ),
                                    })),
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                };
            }
        }
    );

    server.tool(
        'plan_workflow',
        'Given a set of starting artifact types and target artifact types, finds a step-by-step workflow path connecting them through intermediate actions. Returns an ordered plan of actions to execute.',
        {
            from: z.array(z.string()).describe('List of artifact types available as starting inputs'),
            to: z.array(z.string()).describe('List of target artifact types to produce'),
            distribution: z.string().optional().describe('Optional distribution name to scope the search'),
            include_plugins: z
                .array(z.string())
                .optional()
                .describe(
                    'Prefer actions from these plugins in the plan. Dependency plugins are still used when needed.'
                ),
            exclude_plugins: z
                .array(z.string())
                .optional()
                .describe('Exclude actions from these plugins (blocklist)'),
            max_depth: z
                .number()
                .int()
                .min(1)
                .max(50)
                .optional()
                .default(10)
                .describe('Maximum number of BFS depth levels to explore'),
            version: versionParam,
        },
        async ({
            from,
            to,
            distribution,
            include_plugins,
            exclude_plugins,
            max_depth,
            version,
        }: {
            from: string[];
            to: string[];
            distribution?: string;
            include_plugins?: string[];
            exclude_plugins?: string[];
            max_depth: number;
            version?: string;
        }) => {
            try {
                const { graph } = getGraph(version);
                const plan = graph.planWorkflow(from, to, {
                    distribution,
                    includePlugins: include_plugins,
                    excludePlugins: exclude_plugins,
                    maxDepth: max_depth,
                });
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    steps: plan.steps.map((step) => ({
                                        step_id: step.step_id,
                                        action_id: step.action_id,
                                        output_type: step.output_type,
                                        depends_on: step.depends_on,
                                    })),
                                    achieved_targets: plan.achieved_targets,
                                    missing_inputs: plan.missing_inputs,
                                    warnings: plan.warnings,
                                    available_types: plan.available_types,
                                    graph: toMermaid(plan.steps),
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                };
            }
        }
    );

    server.tool(
        'find_consumers',
        'Finds actions that consume all or some of the provided artifact types as inputs.',
        {
            types: z.array(z.string()).describe('List of artifact types to be consumed'),
            distribution: z.string().optional().describe('Optional distribution name to scope consumer search'),
            plugin: z.string().optional().describe('Optional plugin name to scope consumer search'),
            match_mode: z
                .enum(['required_inputs', 'strict_consumption'])
                .optional()
                .default('required_inputs')
                .describe('Consumer matching mode. Defaults to required_inputs.'),
            version: versionParam,
        },
        async ({
            types,
            distribution,
            plugin,
            match_mode,
            version,
        }: {
            types: string[];
            distribution?: string;
            plugin?: string;
            match_mode: 'required_inputs' | 'strict_consumption';
            version?: string;
        }) => {
            try {
                const { graph } = getGraph(version);
                const consumers = graph.findConsumers(types, match_mode, { distribution, plugin });
                const consumerStrings = normalizeActionIds(
                    consumers.map((c) => toActionId(c.plugin, c.action))
                );
                return { content: [{ type: 'text', text: JSON.stringify(consumerStrings, null, 2) }] };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                };
            }
        }
    );

    server.tool(
        'compare_versions',
        'Compares two QIIME 2 schema versions and returns actions that were added, removed, or had their interface (inputs, parameters, outputs) changed. If from_version is omitted, the version immediately preceding to_version is used.',
        {
            to_version: z.string().describe('The target version to compare to (e.g. "2025.4")'),
            from_version: z
                .string()
                .optional()
                .describe('The base version to compare from. Defaults to the version preceding to_version.'),
        },
        async ({ from_version, to_version }: { from_version?: string; to_version: string }) => {
            try {
                const { schema: toSchema, version: tv } = getSchema(to_version);
                let fv = from_version;
                if (!fv) {
                    const idx = AVAILABLE_VERSIONS.indexOf(tv);
                    if (idx <= 0) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        error: `No preceding version for "${tv}". Provide from_version explicitly.`,
                                    }),
                                },
                            ],
                        };
                    }
                    fv = AVAILABLE_VERSIONS[idx - 1];
                }
                const { schema: fromSchema, version: resolvedFv } = getSchema(fv);
                const diff = diffSchemas(fromSchema, toSchema, resolvedFv, tv);
                return { content: [{ type: 'text', text: JSON.stringify(diff, null, 2) }] };
            } catch (e: any) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] };
            }
        }
    );

    server.tool(
        'find_producers',
        'Finds actions that produce all of the specified artifact types as outputs.',
        {
            types: z.array(z.string()).describe('List of artifact types to be produced'),
            distribution: z.string().optional().describe('Optional distribution name to scope producer search'),
            plugin: z.string().optional().describe('Optional plugin name to scope producer search'),
            version: versionParam,
        },
        async ({
            types,
            distribution,
            plugin,
            version,
        }: {
            types: string[];
            distribution?: string;
            plugin?: string;
            version?: string;
        }) => {
            try {
                const { graph } = getGraph(version);
                const producers = graph.findProducers(types, { distribution, plugin });
                const producerStrings = normalizeActionIds(
                    producers.map((p) => toActionId(p.plugin, p.action))
                );
                return { content: [{ type: 'text', text: JSON.stringify(producerStrings, null, 2) }] };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                };
            }
        }
    );
};
