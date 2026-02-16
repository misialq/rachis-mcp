import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { KnowledgeGraph } from "./graph.js";
import { normalizeActionIds, toActionId } from "./action-utils.js";
import schema from "./schema.json";
import schemaDiff from "./schema-diff.json";
import { Schema } from "./types.js";

export class RachisMCP extends McpAgent {
	server: McpServer;
	graph: KnowledgeGraph;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);

		const version = env.RACHIS_VERSION || "unknown";

		this.server = new McpServer({
			name: "Rachis MCP",
			version: version,
		});

		const versionedSchema: Schema = { ...schema, version: version } as any;
		this.graph = new KnowledgeGraph(versionedSchema);
	}

	async init() {
		// Tool: List all available plugins
		this.server.tool(
			"list_available_plugins",
			{
				distribution: z
					.string()
					.optional()
					.describe("Optional distribution name to filter plugins"),
			},
			async ({ distribution }) => {
				try {
					const plugins = this.graph.getPlugins(distribution);
					return {
						content: [{ type: "text", text: JSON.stringify(plugins, null, 2) }],
					};
				} catch (e: any) {
					return {
						content: [{ type: "text", text: JSON.stringify({ error: e.message }) }],
					};
				}
			},
		);

		// Tool: List available distributions
		this.server.tool("list_distributions", {}, async () => {
			const distributions = this.graph.getDistributions();
			return {
				content: [{ type: "text", text: JSON.stringify(distributions, null, 2) }],
			};
		});

		// Tool: Get details for a specific action
		this.server.tool(
			"get_action_details",
			{
				plugin_name: z.string().describe("The name of the plugin"),
				action_name: z.string().describe("The name of the action"),
			},
			async ({ plugin_name, action_name }) => {
				const action = this.graph.getAction(plugin_name, action_name);

				if (!action) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: `Action '${plugin_name}:${action_name}' not found.`,
								}),
							},
						],
					};
				}

				return { content: [{ type: "text", text: JSON.stringify(action, null, 2) }] };
			},
		);

		// Tool: Find compatible actions (Inputs)
		this.server.tool(
			"find_compatible_actions",
			{ semantic_type: z.string() },
			async ({ semantic_type }) => {
				const compatible: string[] = [];
				const allActions = this.graph.getAllActions();

				for (const { plugin, action, details } of allActions) {
					if (!details.inputs) continue;
					for (const input of Object.values(details.inputs)) {
						// input.type is string[]
						const types = (input as any).type as string[];
						if (!types) continue;

						for (const t of types) {
							if (this.graph.checkCompatibility(semantic_type, t)) {
								compatible.push(toActionId(plugin, action));
								break;
							}
						}
					}
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(normalizeActionIds(compatible), null, 2),
						},
					],
				};
			},
		);

		// Tool: Find consumers for a set of artifacts
		this.server.tool(
			"find_consumers",
			{
				types: z.array(z.string()).describe("List of artifact types to be consumed"),
				match_mode: z
					.enum(["required_inputs", "strict_consumption"])
					.optional()
					.default("required_inputs")
					.describe("Consumer matching mode. Defaults to required_inputs."),
			},
			async ({ types, match_mode }) => {
				const consumers = this.graph.findConsumers(types, match_mode);
				const consumerStrings = normalizeActionIds(
					consumers.map((c) => toActionId(c.plugin, c.action)),
				);
				return {
					content: [{ type: "text", text: JSON.stringify(consumerStrings, null, 2) }],
				};
			},
		);

		// Tool: Find producers for a set of artifacts
		this.server.tool(
			"find_producers",
			{ types: z.array(z.string()).describe("List of artifact types to be produced") },
			async ({ types }) => {
				const producers = this.graph.findProducers(types);
				const producerStrings = normalizeActionIds(
					producers.map((p) => toActionId(p.plugin, p.action)),
				);
				return {
					content: [{ type: "text", text: JSON.stringify(producerStrings, null, 2) }],
				};
			},
		);

		// Tool: Find workflow between two semantic types
		this.server.tool(
			"find_workflow",
			{
				start_type: z.string().describe("The starting semantic type"),
				end_type: z.string().describe("The target semantic type"),
				max_depth: z
					.number()
					.optional()
					.default(5)
					.describe("Maximum recursion depth (default: 5)"),
			},
			async ({ start_type, end_type, max_depth }) => {
				const workflow = this.graph.findWorkflow(start_type, end_type, max_depth);

				if (!workflow) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: `No workflow found from '${start_type}' to '${end_type}' within depth ${max_depth}.`,
								}),
							},
						],
					};
				}

				return { content: [{ type: "text", text: JSON.stringify(workflow, null, 2) }] };
			},
		);

		// Tool: Get new capabilities
		this.server.tool("get_new_capabilities", {}, async () => {
			return {
				content: [{ type: "text", text: JSON.stringify(schemaDiff, null, 2) }],
			};
		});
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
