import { z } from 'zod';
import { normalizeActionIds, toActionId } from './action-utils.js';
import type { KnowledgeGraph } from './graph.js';

export interface ToolRegistrar {
    tool: (...args: any[]) => unknown;
}

export const registerRachisTools = (server: ToolRegistrar, graph: KnowledgeGraph): void => {
    server.tool(
        'list_available_plugins',
        'Lists all available Rachis plugins. Optionally filter by distribution name.',
        { distribution: z.string().optional().describe('Optional distribution name to filter plugins') },
        async ({ distribution }: { distribution?: string }) => {
            try {
                const plugins = graph.getPlugins(distribution);
                return {
                    content: [{ type: 'text', text: JSON.stringify(plugins, null, 2) }]
                };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }]
                };
            }
        }
    );

    server.tool(
        'list_distributions',
        'Lists all available Rachis distributions.',
        {},
        async () => {
            const distributions = graph.getDistributions();
            return {
                content: [{ type: 'text', text: JSON.stringify(distributions, null, 2) }]
            };
        }
    );

    server.tool(
        'get_type_details',
        'Retrieves the description and details for a specific Rachis semantic type.',
        { type_name: z.string().describe('The name of the semantic type') },
        async ({ type_name }: { type_name: string }) => {
            const description = graph.getType(type_name);
            if (description === undefined) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: `Type '${type_name}' not found.` }) }]
                };
            }
            return {
                content: [{ type: 'text', text: description || 'No description available.' }]
            };
        }
    );

    server.tool(
        'get_action_details',
        'Retrieves the details, inputs, outputs, and parameters for a specific Rachis plugin action.',
        {
            plugin_name: z.string().describe('The name of the plugin'),
            action_name: z.string().describe('The name of the action')
        },
        async ({ plugin_name, action_name }: { plugin_name: string, action_name: string }) => {
            const action = graph.getAction(plugin_name, action_name);

            if (!action) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: `Action '${plugin_name}:${action_name}' not found.` }) }] };
            }

            return { content: [{ type: 'text', text: JSON.stringify(action, null, 2) }] };
        }
    );

    server.tool(
        'find_compatible_actions',
        'Finds all Rachis actions that accept the provided semantic type as an input.',
        {
            semantic_type: z.string().describe('The semantic type to find compatible actions for'),
            distribution: z.string().optional().describe('Optional distribution name to scope the search'),
            plugin: z.string().optional().describe('Optional plugin name to scope the search'),
        },
        async ({ semantic_type, distribution, plugin }: { semantic_type: string, distribution?: string, plugin?: string }) => {
            try {
                const compatible = graph.findCompatibleActions(semantic_type, { distribution, plugin });
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(
                            normalizeActionIds(compatible.map(({ plugin, action }) => toActionId(plugin, action))),
                            null,
                            2
                        )
                    }]
                };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }]
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
            limit: z.number().int().min(1).max(25).optional().default(10)
                .describe('Maximum number of candidate semantic types to return'),
        },
        async ({ kind, distribution, plugin, limit }: { kind: string, distribution?: string, plugin?: string, limit: number }) => {
            try {
                const candidates = graph.findInputTypeCandidates(kind, { distribution, plugin, limit });
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            kind,
                            candidates: candidates.map((candidate) => ({
                                semantic_type: candidate.semantic_type,
                                description: candidate.description,
                                score: candidate.score,
                                match_sources: candidate.match_sources,
                                matched_terms: candidate.matched_terms,
                                common_input_names: candidate.common_input_names,
                                consumers: normalizeActionIds(
                                    candidate.consumers.map(({ plugin, action }) => toActionId(plugin, action))
                                ),
                            })),
                        }, null, 2)
                    }]
                };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }]
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
            match_mode: z.enum(['required_inputs', 'strict_consumption'])
                .optional()
                .default('required_inputs')
                .describe('Consumer matching mode. Defaults to required_inputs.'),
        },
        async ({
            types,
            distribution,
            plugin,
            match_mode,
        }: {
            types: string[],
            distribution?: string,
            plugin?: string,
            match_mode: 'required_inputs' | 'strict_consumption',
        }) => {
            try {
                const consumers = graph.findConsumers(types, match_mode, { distribution, plugin });
                const consumerStrings = normalizeActionIds(consumers.map((c) => toActionId(c.plugin, c.action)));
                return { content: [{ type: 'text', text: JSON.stringify(consumerStrings, null, 2) }] };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }]
                };
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
        },
        async ({ types, distribution, plugin }: { types: string[], distribution?: string, plugin?: string }) => {
            try {
                const producers = graph.findProducers(types, { distribution, plugin });
                const producerStrings = normalizeActionIds(producers.map((p) => toActionId(p.plugin, p.action)));
                return { content: [{ type: 'text', text: JSON.stringify(producerStrings, null, 2) }] };
            } catch (e: any) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }]
                };
            }
        }
    );
};
