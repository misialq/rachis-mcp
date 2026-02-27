import type { Action, Parameter, Schema } from './types.js';
import { isTypeCompatible } from './semantic-type.js';

// Graph Representation
// We will not build a full graph object like NetworkX but serve queries directly from the Schema
// for listing. For tracing, we will build an ad-hoc graph or just use the Schema.
// Actually, for BFS, iterating over all actions to find applicable ones is O(Total_Actions).
// Efficient enough for < 1000 actions.

export interface WorkflowStep {
    action_id: string;
    plugin: string;
    action: string;
    output_type: string;
}

export interface MultiWorkflowPlan {
    steps: WorkflowStep[];
    achieved_targets: string[];
    missing_inputs: string[];
    assumptions: string[];
    warnings: string[];
    available_types: string[];
}

export class KnowledgeGraph {
    private schema: Schema;

    constructor(schema: Schema) {
        this.schema = this.normalizeSchema(schema);
    }

    private isMetadataParameter(parameter: Parameter | undefined): boolean {
        return typeof parameter?.type === 'string' && parameter.type.startsWith('Metadata');
    }

    private normalizeAction(action: Action): Action {
        const parameters: Record<string, Parameter> = {};
        const metadata: Record<string, Parameter> = { ...(action.metadata || {}) };

        for (const [name, parameter] of Object.entries(action.parameters || {})) {
            if (this.isMetadataParameter(parameter)) {
                if (!Object.prototype.hasOwnProperty.call(metadata, name)) {
                    metadata[name] = parameter;
                }
                continue;
            }
            parameters[name] = parameter;
        }

        return {
            ...action,
            parameters,
            metadata,
        };
    }

    private normalizeSchema(schema: Schema): Schema {
        const plugins: Schema['plugins'] = {};

        for (const [pluginName, plugin] of Object.entries(schema.plugins)) {
            const actions: typeof plugin.actions = {};
            for (const [actionName, action] of Object.entries(plugin.actions)) {
                actions[actionName] = this.normalizeAction(action);
            }
            plugins[pluginName] = {
                ...plugin,
                actions,
            };
        }

        return {
            ...schema,
            plugins,
        };
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

    getType(typeName: string): string | undefined {
        return this.schema.types[typeName];
    }

    getAction(pluginName: string, actionName: string): Action | undefined {
        const pKey = this.findKey(this.schema.plugins, pluginName);
        if (!pKey) return undefined;
        
        const plugin = this.schema.plugins[pKey];
        const aKey = this.findKey(plugin.actions, actionName);
        if (!aKey) return undefined;
        
        return plugin.actions[aKey];
    }

    getAllActions(): { plugin: string, action: string, details: Action }[] {
        const actions: { plugin: string, action: string, details: Action }[] = [];
        for (const [pName, plugin] of Object.entries(this.schema.plugins)) {
            for (const [aName, action] of Object.entries(plugin.actions)) {
                actions.push({ plugin: pName, action: aName, details: action });
            }
        }
        return actions;
    }

    private matchesInputType(availableType: string, inputDef: { type?: string[] }): boolean {
        if (!inputDef.type) return false;
        return inputDef.type.some((requiredType: string) => this.checkCompatibility(availableType, requiredType));
    }

    private hasCompatibleType(availableTypes: Set<string>, requiredType: string): boolean {
        for (const availableType of availableTypes) {
            if (this.checkCompatibility(availableType, requiredType)) {
                return true;
            }
        }
        return false;
    }

    private addAllActionOutputs(availableTypes: Set<string>, step: WorkflowStep): void {
        const actionDetails = this.getAction(step.plugin, step.action);
        if (!actionDetails?.outputs) {
            availableTypes.add(step.output_type);
            return;
        }

        let addedAny = false;
        for (const outputDef of Object.values(actionDetails.outputs) as Array<{ type?: string[] }>) {
            if (!outputDef.type) continue;
            for (const outputType of outputDef.type) {
                availableTypes.add(outputType);
                addedAny = true;
            }
        }

        if (!addedAny) {
            availableTypes.add(step.output_type);
        }
    }

    findConsumers(availableTypes: string[], matchMode: 'required_inputs' | 'strict_consumption' = 'required_inputs') {
        const consumers: { plugin: string, action: string }[] = [];
        const cleanTypes = availableTypes.map((t) => t.trim()).filter((t) => t.length > 0);

        if (cleanTypes.length === 0) {
            return consumers;
        }

        for (const { plugin, action, details } of this.getAllActions()) {
            if (!details.inputs) continue;

            const actionInputs = Object.values(details.inputs) as { type?: string[], required?: boolean }[];
            if (actionInputs.length === 0) continue;

            const requiredInputs = actionInputs.filter((inputDef) => inputDef.required);
            const requiredSatisfied = requiredInputs.every((inputDef) =>
                cleanTypes.some((availType) => this.matchesInputType(availType, inputDef))
            );

            if (!requiredSatisfied) continue;

            const anyProvidedTypeConsumed = cleanTypes.some((availType) =>
                actionInputs.some((inputDef) => this.matchesInputType(availType, inputDef))
            );

            if (!anyProvidedTypeConsumed) continue;

            if (matchMode === 'strict_consumption') {
                const allProvidedTypesConsumed = cleanTypes.every((availType) =>
                    actionInputs.some((inputDef) => this.matchesInputType(availType, inputDef))
                );
                if (!allProvidedTypesConsumed) continue;
            }

            consumers.push({ plugin, action });
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
        return isTypeCompatible(availType, reqType);
    }
}
