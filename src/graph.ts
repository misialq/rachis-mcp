
import { Schema } from './types.js';

// Graph Representation
// We will not build a full graph object like NetworkX but serve queries directly from the Schema
// for listing. For tracing, we will build an ad-hoc graph or just use the Schema.
// Actually, for BFS, iterating over all actions to find applicable ones is O(Total_Actions).
// Efficient enough for < 1000 actions.

export class KnowledgeGraph {
    private schema: Schema;

    constructor(schema: Schema) {
        this.schema = schema;
    }

    private findKey(obj: Record<string, any>, key: string): string | undefined {
        if (Object.prototype.hasOwnProperty.call(obj, key)) return key;
        const norm = key.replace(/[-_]/g, '_');
        for (const k of Object.keys(obj)) {
            if (k.replace(/[-_]/g, '_') === norm) return k;
        }
        return undefined;
    }

    getPlugins(distribution?: string): string[] {
        if (distribution) {
            const distKey = this.findKey(this.schema.distributions, distribution);
            if (!distKey) throw new Error(`Distribution '${distribution}' not found.`);
            return this.schema.distributions[distKey].plugins;
        }
        return Object.keys(this.schema.plugins);
    }

    getDistributions(): string[] {
        return Object.keys(this.schema.distributions);
    }

    getAction(pluginName: string, actionName: string) {
        const pKey = this.findKey(this.schema.plugins, pluginName);
        if (!pKey) return undefined;
        
        const plugin = this.schema.plugins[pKey];
        const aKey = this.findKey(plugin.actions, actionName);
        if (!aKey) return undefined;
        
        return plugin.actions[aKey];
    }

    getAllActions(): { plugin: string, action: string, details: any }[] {
        const actions = [];
        for (const [pName, plugin] of Object.entries(this.schema.plugins)) {
            for (const [aName, action] of Object.entries(plugin.actions)) {
                actions.push({ plugin: pName, action: aName, details: action });
            }
        }
        return actions;
    }
    
    // --- Compatibility Logic ---

    // Ported from Python: check_compatibility
    checkCompatibility(availType: string, reqType: string): boolean {
        // IMPLICIT LIFT: T can satisfy List[T]
        if (reqType.startsWith('List[') && !availType.startsWith('List[')) {
             const innerReq = reqType.slice(5, -1);
             return this.checkCompatibility(availType, innerReq);
        }

        // Helper to decompose a type string into { head, args, props }
        // Handles 'Type[Args] % Properties(P)' and 'Type % Properties(P)'
        const parseRobust = (t: string) => {
            // 1. Extract Properties if present at the top level (suffix)
            let props = new Set<string>();
            let cleanType = t;
            
            // Hacky regex for top-level properties
            const propMatch = t.match(/%\s*Properties\((.*)\)$/);
            if (propMatch) {
                const propsRaw = propMatch[1].split(',').map(p => p.trim().replace(/^['"]|['"]$/g, ''));
                propsRaw.forEach(p => props.add(p));
                cleanType = t.substring(0, propMatch.index).trim();
            }

            // 2. Extract Head and Args
            const headMatch = cleanType.match(/^([a-zA-Z0-9_]+)(?:\[(.*)\])?$/);
            if (!headMatch) {
                return { head: cleanType, args: null, props };
            }
            return { head: headMatch[1], args: headMatch[2] || null, props };
        };

        const av = parseRobust(availType);
        const req = parseRobust(reqType);

        // 1. Check Head Equality (e.g. SampleData == SampleData)
        if (av.head !== req.head) return false;

        // 2. Check Properties (Req props must be subset of Avail props)
        // Note: This only checks top-level properties. Nested properties are handled by recursion on args.
        for (const p of req.props) {
            if (!av.props.has(p)) return false;
        }
        
        // 3. Check Arguments Recursively
        if (req.args) {
            if (!av.args) return false; // Req expects args, Avail has none -> fail
            
            // If args contain nested structure, we need to recurse.
            // But args might be complex strings?
            // For single generic 'SampleData[T]', args is 'T'.
            // Recurse: checkCompatibility(av.args, req.args)
            
            // Handle cases where args might have embedded properties that look like different strings
            // e.g. T % Props vs T
            return this.checkCompatibility(av.args, req.args);
        }

        return true;
    }
}
