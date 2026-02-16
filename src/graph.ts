import { Schema } from './types.js';
import { isTypeCompatible } from './semantic-type.js';
import {
    type PlanningConstraints,
    type NormalizedPlanningConstraints,
    isActionAllowedByConstraints,
    normalizePlanningConstraints,
} from './planning-intent.js';

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

    getType(typeName: string): string | undefined {
        return this.schema.types[typeName];
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

    private findWorkflowFromAvailableTypes(
        startTypes: Set<string>,
        endType: string,
        maxDepth: number = 5,
        constraints: NormalizedPlanningConstraints = normalizePlanningConstraints(),
        requiredPluginPriority: Set<string> = new Set()
    ): WorkflowStep[] | null {
        const allActions = this.getAllActions();

        // Helper: recursive resolver with Iterative Deepening
        const resolve = (targetType: string, availableTypes: Set<string>, currentDepth: number, limit: number, stack: Set<string>): WorkflowStep[] | null => {

            // 1. Check if we already have the type
            if (this.hasCompatibleType(availableTypes, targetType)) {
                return []; // No actions needed, we have it.
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
            const filteredCandidates = candidates.filter((candidate) =>
                isActionAllowedByConstraints(`${candidate.plugin}:${candidate.action}`, candidate.plugin, constraints)
            );

            const prioritizedCandidates =
                requiredPluginPriority.size === 0
                    ? filteredCandidates
                    : [
                        ...filteredCandidates.filter((candidate) => requiredPluginPriority.has(candidate.plugin.toLowerCase())),
                        ...filteredCandidates.filter((candidate) => !requiredPluginPriority.has(candidate.plugin.toLowerCase())),
                    ];

            for (const candidate of prioritizedCandidates) {
                const requiredInputs = candidate.details.inputs || {};
                let currentPlan: WorkflowStep[] = [];
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
                             this.addAllActionOutputs(branchAvailable, step);
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
                        action_id: `${candidate.plugin}:${candidate.action}`,
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
            const result = resolve(endType, new Set(startTypes), 0, limit, new Set());
            if (result) {
                return result;
            }
        }

        return null;
    }

    findWorkflow(startType: string, endType: string, maxDepth: number = 5): WorkflowStep[] | null {
        return this.findWorkflowFromAvailableTypes(
            new Set([startType]),
            endType,
            maxDepth,
            normalizePlanningConstraints(),
            new Set()
        );
    }

    planWorkflowMulti(
        availableTypes: string[],
        targetTypes: string[],
        maxDepth: number = 5,
        planningConstraints: PlanningConstraints = {}
    ): MultiWorkflowPlan {
        const cleanAvailableTypes = Array.from(
            new Set(availableTypes.map((value) => value.trim()).filter((value) => value.length > 0))
        );
        const cleanTargetTypes = Array.from(
            new Set(targetTypes.map((value) => value.trim()).filter((value) => value.length > 0))
        );

        const availableSet = new Set(cleanAvailableTypes);
        const steps: WorkflowStep[] = [];
        const seenActionIds = new Set<string>();
        const achievedTargets: string[] = [];
        const missingInputs: string[] = [];
        const warnings: string[] = [];
        const constraints = normalizePlanningConstraints(planningConstraints);
        const missingRequiredPlugins = new Set(constraints.requiredPlugins);

        const assumptions = [
            "Compatibility checks use semantic type matching and implicit List lift (T satisfies List[T]).",
            "Each target is planned independently and merged into a combined execution plan.",
        ];

        if (cleanTargetTypes.length === 0) {
            warnings.push("No target_types were provided.");
        }

        if (constraints.allowedPlugins.size > 0) {
            assumptions.push(`Planner restricted to allowed_plugins=[${Array.from(constraints.allowedPlugins).join(', ')}].`);
        }
        if (constraints.requiredPlugins.size > 0) {
            assumptions.push(`Planner prioritizing required_plugins=[${Array.from(constraints.requiredPlugins).join(', ')}].`);
        }
        if (constraints.disallowedPlugins.size > 0) {
            assumptions.push(`Planner restricted by disallowed_plugins=[${Array.from(constraints.disallowedPlugins).join(', ')}].`);
        }

        for (const targetType of cleanTargetTypes) {
            if (this.hasCompatibleType(availableSet, targetType)) {
                achievedTargets.push(targetType);
                continue;
            }

            const plan = this.findWorkflowFromAvailableTypes(
                new Set(availableSet),
                targetType,
                maxDepth,
                constraints,
                missingRequiredPlugins
            );
            if (!plan || plan.length === 0) {
                missingInputs.push(targetType);
                warnings.push(`No workflow found for target '${targetType}' within depth ${maxDepth}.`);
                if (constraints.hasFilteringConstraints) {
                    warnings.push(`Constraint filters may have excluded viable actions for target '${targetType}'.`);
                }
                continue;
            }

            for (const step of plan) {
                if (!seenActionIds.has(step.action_id)) {
                    seenActionIds.add(step.action_id);
                    steps.push(step);
                    missingRequiredPlugins.delete(step.plugin.toLowerCase());
                }
                this.addAllActionOutputs(availableSet, step);
            }

            if (this.hasCompatibleType(availableSet, targetType)) {
                achievedTargets.push(targetType);
            } else {
                missingInputs.push(targetType);
                warnings.push(`Workflow for target '${targetType}' did not resolve all required intermediate inputs.`);
            }
        }

        if (missingInputs.length > 0) {
            warnings.push("Plan is partial. Some target types could not be satisfied from the provided available_types.");
        }
        if (missingRequiredPlugins.size > 0) {
            warnings.push(`Required plugins were not included in the final plan: ${Array.from(missingRequiredPlugins).join(', ')}.`);
        }

        return {
            steps,
            achieved_targets: achievedTargets,
            missing_inputs: missingInputs,
            assumptions,
            warnings,
            available_types: Array.from(availableSet).sort((a, b) => a.localeCompare(b)),
        };
    }
}
