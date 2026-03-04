import { KnowledgeGraph } from './graph.js';
import { getSchema } from './schema-registry.js';

const graphCache = new Map<string, KnowledgeGraph>();

export function getGraph(version?: string): { graph: KnowledgeGraph; version: string } {
    const { schema, version: v } = getSchema(version);
    if (!graphCache.has(v)) {
        graphCache.set(v, new KnowledgeGraph(schema));
    }
    return { graph: graphCache.get(v)!, version: v };
}
