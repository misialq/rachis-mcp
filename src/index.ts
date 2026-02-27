
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { KnowledgeGraph } from "./graph.js";
import { normalizeActionIds, toActionId } from "./action-utils.js";
import schema from "./schema.json";

// Typed Schema Import
// In a real build, we might need to assert the type or load it differently
const graph = new KnowledgeGraph(schema as any);

export class RachisMCP extends McpAgent {
    server = new McpServer({
        name: "Rachis MCP",
        version: "1.0.0",
    });

    async init() {
        // Tool: List all available plugins
        this.server.tool(
            "list_available_plugins",
            { distribution: z.string().optional().describe("Optional distribution name to filter plugins") },
            async ({ distribution }) => {
                try {
                    const plugins = graph.getPlugins(distribution);
                    return {
                        content: [{ type: "text", text: JSON.stringify(plugins, null, 2) }]
                    };
                } catch (e: any) {
                     return {
                        content: [{ type: "text", text: JSON.stringify({ error: e.message }) }]
                    };
                }
            }
        );

        // Tool: List available distributions
        this.server.tool(
            "list_distributions",
            {},
            async () => {
                const distributions = graph.getDistributions();
                return {
                    content: [{ type: "text", text: JSON.stringify(distributions, null, 2) }]
                };
            }
        );

        // Tool: Get details for a specific semantic type
        this.server.tool(
            "get_type_details",
            { type_name: z.string().describe("The name of the semantic type") },
            async ({ type_name }) => {
                const description = graph.getType(type_name);
                if (description === undefined) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({ error: `Type '${type_name}' not found.` }) }]
                    };
                }
                return {
                    content: [{ type: "text", text: description || "No description available." }]
                };
            }
        );

        // Tool: Get details for a specific action
        this.server.tool(
            "get_action_details",
            { 
                plugin_name: z.string().describe("The name of the plugin"),
                action_name: z.string().describe("The name of the action")
            },
            async ({ plugin_name, action_name }) => {
                const action = graph.getAction(plugin_name, action_name);
                
                if (!action) {
                    return { content: [{ type: "text", text: JSON.stringify({ error: `Action '${plugin_name}:${action_name}' not found.` }) }] };
                }

                return { content: [{ type: "text", text: JSON.stringify(action, null, 2) }] };
            }
        );

        // Tool: Find compatible actions (Inputs)
        this.server.tool(
            "find_compatible_actions",
            { semantic_type: z.string().describe("The semantic type to find compatible actions for") },
            async ({ semantic_type }) => {
                const compatible: string[] = [];
                const allActions = graph.getAllActions();
                
                for (const { plugin, action, details } of allActions) {
                     if (!details.inputs) continue;
                     for (const input of Object.values(details.inputs)) {
                         // input.type is string | string[]
                         const typeRaw = (input as any).type;
                         if (!typeRaw) continue;
                         const types = Array.isArray(typeRaw) ? typeRaw : [typeRaw];
                         
                         for (const t of types) {
                             if (graph.checkCompatibility(semantic_type, t)) {
                                 compatible.push(toActionId(plugin, action));
                                 break; 
                             }
                         }
                     }
                }
                return { content: [{ type: "text", text: JSON.stringify(normalizeActionIds(compatible), null, 2) }] };
            }
        );

        // Tool: Find consumers for a set of artifacts
        this.server.tool(
            "find_consumers",
            {
                types: z.array(z.string()).describe("List of artifact types to be consumed"),
                match_mode: z.enum(["required_inputs", "strict_consumption"])
                    .optional()
                    .default("required_inputs")
                    .describe("Consumer matching mode. Defaults to required_inputs."),
            },
            async ({ types, match_mode }) => {
                const consumers = graph.findConsumers(types, match_mode);
                const consumerStrings = normalizeActionIds(consumers.map((c) => toActionId(c.plugin, c.action)));
                return { content: [{ type: "text", text: JSON.stringify(consumerStrings, null, 2) }] };
            }
        );

        // Tool: Find producers for a set of artifacts
        this.server.tool(
            "find_producers",
            { types: z.array(z.string()).describe("List of artifact types to be produced") },
            async ({ types }) => {
                const producers = graph.findProducers(types);
                const producerStrings = normalizeActionIds(producers.map((p) => toActionId(p.plugin, p.action)));
                return { content: [{ type: "text", text: JSON.stringify(producerStrings, null, 2) }] };
            }
        );
    }
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return RachisMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
