
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
    
    findConsumers(availableTypes: string[]) {
        const consumers: { plugin: string, action: string }[] = [];
        
        for (const { plugin, action, details } of this.getAllActions()) {
            if (!details.inputs) continue;
            
            const actionInputs = Object.values(details.inputs);
            // Track usage count for each input
            const inputUsage = new Array(actionInputs.length).fill(0);
            
            let allMatched = true;

            for (const availType of availableTypes) {
                let matchedObj = false;
                
                for (let i = 0; i < actionInputs.length; i++) {
                    const inputDef = actionInputs[i] as any;
                    
                    // If it's not a List/Collection, it can only be used once
                    // We assume any type starting with "List" or "Collection" is variadic
                    const isVariadic = inputDef.type.some((t: string) => t.startsWith('List') || t.startsWith('Collection'));
                    
                    if (!isVariadic && inputUsage[i] > 0) continue;
                    
                    let typeCompatible = false;
                     if (inputDef.type) {
                         for (const reqType of inputDef.type) {
                            if (this.checkCompatibility(availType, reqType)) {
                                typeCompatible = true;
                                break;
                            }
                        }
                    }

                    if (typeCompatible) {
                        inputUsage[i]++;
                        matchedObj = true;
                        break;
                    }
                }

                if (!matchedObj) {
                    allMatched = false;
                    break;
                }
            }

            if (allMatched && availableTypes.length > 0) {
                consumers.push({ plugin, action });
            }
        }
        return consumers;
    }

    findProducers(requiredTypes: string[]) {
        const producers: { plugin: string, action: string }[] = [];
        
        for (const { plugin, action, details } of this.getAllActions()) {
            if (!details.outputs) continue;
            
            const actionOutputs = Object.values(details.outputs);
            const outputUsage = new Array(actionOutputs.length).fill(0);
            
            let allMatched = true;

            for (const reqType of requiredTypes) {
                let matchedObj = false;

                for (let i = 0; i < actionOutputs.length; i++) {
                    const outputDef = actionOutputs[i] as any;
                    
                    if (outputUsage[i] > 0) continue; 

                    let typeCompatible = false;
                    if (outputDef.type) {
                        for (const availType of outputDef.type) {
                            if (this.checkCompatibility(availType, reqType)) {
                                typeCompatible = true;
                                break;
                            }
                        }
                    }

                    if (typeCompatible) {
                        outputUsage[i]++;
                        matchedObj = true;
                        break;
                    }
                }

                if (!matchedObj) {
                    allMatched = false;
                    break;
                }
            }

            if (allMatched && requiredTypes.length > 0) {
                producers.push({ plugin, action });
            }
        }
        return producers;
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

    findWorkflow(startType: string, endType: string, maxDepth: number = 5): { plugin: string, action: string, output_type: string }[] | null {
        const allActions = this.getAllActions();

        // Helper: recursive resolver with Iterative Deepening
        const resolve = (targetType: string, availableTypes: Set<string>, currentDepth: number, limit: number, stack: Set<string>): { plugin: string, action: string, output_type: string }[] | null => {

            // 1. Check if we already have the type
            for (const avail of availableTypes) {
                if (this.checkCompatibility(avail, targetType)) {
                    return []; // No actions needed, we have it.
                }
            }

            if (currentDepth >= limit) return null;
            if (stack.has(targetType)) return null; // Cycle detected

            stack.add(targetType);

            // 2. Find all actions that produce a compatible type
            const candidates = [];
            for (const act of allActions) {
                if (!act.details.outputs) continue;
                for (const outKey in act.details.outputs) {
                    const outDef = act.details.outputs[outKey];
                    // outDef.type is string[]
                    for (const outType of (outDef.type as string[])) {
                         if (this.checkCompatibility(outType, targetType)) {
                             candidates.push({ ...act, producedType: outType });
                         }
                    }
                }
            }

            // 3. Try to resolve inputs for each candidate
            for (const candidate of candidates) {
                const requiredInputs = candidate.details.inputs || {};
                let currentPlan: { plugin: string, action: string, output_type: string }[] = [];
                let possible = true;
                const branchAvailable = new Set(availableTypes);

                for (const inputKey in requiredInputs) {
                    const inputDef = requiredInputs[inputKey];
                    if (!inputDef.required) continue;

                    const validTypes = inputDef.type as string[];
                    let inputResolved = false;
                    let bestInputSubPlan: typeof currentPlan | null = null;

                    for (const reqInputType of validTypes) {
                        const subPlan = resolve(reqInputType, branchAvailable, currentDepth + 1, limit, new Set(stack));
                        if (subPlan !== null) {
                            if (bestInputSubPlan === null || subPlan.length < bestInputSubPlan.length) {
                                bestInputSubPlan = subPlan;
                            }
                        }
                    }

                    if (bestInputSubPlan) {
                        for (const step of bestInputSubPlan) {
                             currentPlan.push(step);
                             branchAvailable.add(step.output_type);
                        }
                        inputResolved = true;
                    }

                    if (!inputResolved) {
                        possible = false;
                        break;
                    }
                }

                if (possible) {
                    currentPlan.push({
                        plugin: candidate.plugin,
                        action: candidate.action,
                        output_type: candidate.producedType
                    });
                    // With Iterative Deepening, the first found at this depth limit is optimal for this depth.
                    return currentPlan;
                }
            }

            stack.delete(targetType);
            return null;
        };

        // Iterative Deepening
        for (let limit = 1; limit <= maxDepth; limit++) {
            const result = resolve(endType, new Set([startType]), 0, limit, new Set());
            if (result) return result;
        }

        return null;
    }
}
