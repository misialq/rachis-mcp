import type { Action, Parameter, Schema } from './types.js';
import { isTypeCompatible, parseSemanticType, type ParsedSemanticType } from './semantic-type.js';
import { toActionId } from './action-utils.js';

// Graph Representation
// We will not build a full graph object like NetworkX but serve queries directly from the Schema
// for listing. For tracing, we will build an ad-hoc graph or just use the Schema.
// Actually, for BFS, iterating over all actions to find applicable ones is O(Total_Actions).
// Efficient enough for < 1000 actions.

export interface WorkflowStep {
    step_id: number;
    action_id: string;
    plugin: string;
    action: string;
    output_type: string;
    depends_on: number[];
}

export interface MultiWorkflowPlan {
    steps: WorkflowStep[];
    achieved_targets: string[];
    missing_inputs: string[];
    assumptions: string[];
    warnings: string[];
    available_types: string[];
}

export interface TypeDiscoveryCandidate {
    semantic_type: string;
    description: string;
    score: number;
    match_sources: string[];
    matched_terms: string[];
    common_input_names: string[];
    consumers: { plugin: string, action: string }[];
}

interface TypeUsageSummary {
    inputNameCounts: Map<string, number>;
    actionDescriptions: Map<string, number>;
}

const normalizeSearchText = (value: string): string =>
    value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

const singularizeToken = (token: string): string => {
    if (token.length <= 3) return token;
    if (token.endsWith('ies') && token.length > 4) {
        return `${token.slice(0, -3)}y`;
    }
    if (/(ches|shes|xes|zes|ses)$/.test(token) && token.length > 4) {
        return token.slice(0, -2);
    }
    if (token.endsWith('s') && !token.endsWith('ss')) {
        return token.slice(0, -1);
    }
    return token;
};

const tokenizeSearchText = (value: string): string[] => {
    const normalized = normalizeSearchText(value);
    if (normalized.length === 0) {
        return [];
    }

    const tokens = normalized.split(' ').filter((token) => token.length > 1 || /^\d+$/.test(token));
    const expanded = new Set<string>();

    for (const token of tokens) {
        expanded.add(token);
        expanded.add(singularizeToken(token));
    }

    return [...expanded].filter((token) => token.length > 0);
};

const scoreTokenMatches = (
    queryTokens: string[],
    candidateTokens: Set<string>,
    exactWeight: number,
    fuzzyWeight: number
): { score: number, matchedTerms: string[] } => {
    let score = 0;
    const matchedTerms = new Set<string>();

    for (const token of queryTokens) {
        if (candidateTokens.has(token)) {
            score += exactWeight;
            matchedTerms.add(token);
            continue;
        }

        if (token.length < 4) continue;

        const fuzzyMatch = [...candidateTokens].some((candidateToken) =>
            candidateToken.length >= 4 && (candidateToken.includes(token) || token.includes(candidateToken))
        );

        if (fuzzyMatch) {
            score += fuzzyWeight;
            matchedTerms.add(token);
        }
    }

    return {
        score,
        matchedTerms: [...matchedTerms],
    };
};

const formatSemanticBaseType = (parsed: ParsedSemanticType): string => {
    if (parsed.args.length === 0) {
        return parsed.head;
    }

    return `${parsed.head}[${parsed.args.map((arg) => formatSemanticBaseType(arg)).join(', ')}]`;
};

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

    private getTypeDescription(typeName: string): string {
        if (typeof this.schema.types[typeName] === 'string') {
            return this.schema.types[typeName];
        }

        const strippedType = formatSemanticBaseType(parseSemanticType(typeName));
        if (typeof this.schema.types[strippedType] === 'string') {
            return this.schema.types[strippedType];
        }

        return '';
    }

    private buildTypeUsageIndex(pluginFilter?: Set<string>): Map<string, TypeUsageSummary> {
        const usage = new Map<string, TypeUsageSummary>();

        for (const { plugin, details } of this.getAllActions()) {
            if (pluginFilter && !pluginFilter.has(plugin)) continue;
            if (!details.inputs) continue;

            for (const [inputName, inputDef] of Object.entries(details.inputs)) {
                const rawTypes = (inputDef as { type?: string | string[] }).type;
                if (!rawTypes) continue;

                const inputTypes = Array.isArray(rawTypes) ? rawTypes : [rawTypes];
                for (const inputType of inputTypes) {
                    const existing = usage.get(inputType) || {
                        inputNameCounts: new Map<string, number>(),
                        actionDescriptions: new Map<string, number>(),
                    };

                    existing.inputNameCounts.set(inputName, (existing.inputNameCounts.get(inputName) || 0) + 1);

                    const actionDescription = details.description?.trim();
                    if (actionDescription) {
                        existing.actionDescriptions.set(
                            actionDescription,
                            (existing.actionDescriptions.get(actionDescription) || 0) + 1
                        );
                    }

                    usage.set(inputType, existing);
                }
            }
        }

        return usage;
    }

    private matchesInputType(availableType: string, inputDef: { type?: any }): boolean {
        if (!inputDef.type) return false;
        const requiredTypes = Array.isArray(inputDef.type) ? inputDef.type : [inputDef.type];
        return requiredTypes.some((requiredType: string) => this.checkCompatibility(availableType, requiredType));
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
        for (const outputDef of Object.values(actionDetails.outputs) as Array<{ type?: any }>) {
            if (!outputDef.type) continue;
            const outputTypes = Array.isArray(outputDef.type) ? outputDef.type : [outputDef.type];
            for (const outputType of outputTypes) {
                availableTypes.add(outputType);
                addedAny = true;
            }
        }

        if (!addedAny) {
            availableTypes.add(step.output_type);
        }
    }

    findConsumers(
        availableTypes: string[],
        matchMode: 'required_inputs' | 'strict_consumption' = 'required_inputs',
        filters?: { distribution?: string, plugin?: string }
    ) {
        const consumers: { plugin: string, action: string }[] = [];
        const cleanTypes = availableTypes.map((t) => t.trim()).filter((t) => t.length > 0);
        const pluginFilter = this.resolvePluginFilter(filters);

        if (cleanTypes.length === 0) {
            return consumers;
        }

        for (const { plugin, action, details } of this.getAllActions()) {
            if (pluginFilter && !pluginFilter.has(plugin)) continue;
            if (!details.inputs) continue;

            const actionInputs = Object.values(details.inputs) as { type?: any, required?: boolean }[];
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

    findCompatibleActions(
        semanticType: string,
        filters?: { distribution?: string, plugin?: string }
    ) {
        const compatible: { plugin: string, action: string }[] = [];
        const pluginFilter = this.resolvePluginFilter(filters);

        for (const { plugin, action, details } of this.getAllActions()) {
            if (pluginFilter && !pluginFilter.has(plugin)) continue;
            if (!details.inputs) continue;

            const actionInputs = Object.values(details.inputs) as Array<{ type?: string | string[] }>;
            const matchesAnyInput = actionInputs.some((inputDef) => {
                if (!inputDef.type) return false;
                const requiredTypes = Array.isArray(inputDef.type) ? inputDef.type : [inputDef.type];
                return requiredTypes.some((requiredType) => this.checkCompatibility(semanticType, requiredType));
            });

            if (matchesAnyInput) {
                compatible.push({ plugin, action });
            }
        }

        return compatible;
    }

    findInputTypeCandidates(
        query: string,
        filters?: { distribution?: string, plugin?: string, limit?: number }
    ): TypeDiscoveryCandidate[] {
        const normalizedQuery = normalizeSearchText(query);
        const queryTokens = tokenizeSearchText(query);

        if (normalizedQuery.length === 0 || queryTokens.length === 0) {
            return [];
        }

        const pluginFilter = this.resolvePluginFilter(filters);
        const usageIndex = this.buildTypeUsageIndex(pluginFilter);
        const candidateTypes = new Set<string>([
            ...Object.keys(this.schema.types),
            ...usageIndex.keys(),
        ]);
        const limit = Math.max(1, filters?.limit ?? 10);
        const candidates: TypeDiscoveryCandidate[] = [];

        for (const semanticType of candidateTypes) {
            const consumers = this.findCompatibleActions(semanticType, filters);
            if (consumers.length === 0) continue;

            const usage = usageIndex.get(semanticType);
            const description = this.getTypeDescription(semanticType);
            const typeTokens = new Set(tokenizeSearchText(semanticType));
            const descriptionTokens = new Set(tokenizeSearchText(description));
            const commonInputNames = [...(usage?.inputNameCounts.entries() || [])]
                .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
            const inputNameTokens = new Set(
                commonInputNames.flatMap(([inputName]) => tokenizeSearchText(inputName))
            );
            const actionDescriptionTexts = [...(usage?.actionDescriptions.keys() || [])];
            const actionDescriptionTokens = new Set(
                actionDescriptionTexts.flatMap((actionDescription) => tokenizeSearchText(actionDescription))
            );

            let score = 0;
            const matchedTerms = new Set<string>();
            const matchSources = new Set<string>();

            const typeMatches = scoreTokenMatches(queryTokens, typeTokens, 7, 3);
            if (typeMatches.score > 0) {
                score += typeMatches.score;
                typeMatches.matchedTerms.forEach((term) => matchedTerms.add(term));
                matchSources.add('type_name');
            }

            const descriptionMatches = scoreTokenMatches(queryTokens, descriptionTokens, 3, 1);
            if (descriptionMatches.score > 0) {
                score += descriptionMatches.score;
                descriptionMatches.matchedTerms.forEach((term) => matchedTerms.add(term));
                matchSources.add('type_description');
            }

            const inputNameMatches = scoreTokenMatches(queryTokens, inputNameTokens, 10, 4);
            if (inputNameMatches.score > 0) {
                score += inputNameMatches.score;
                inputNameMatches.matchedTerms.forEach((term) => matchedTerms.add(term));
                matchSources.add('input_name');
            }

            const actionDescriptionMatches = scoreTokenMatches(queryTokens, actionDescriptionTokens, 2, 1);
            if (actionDescriptionMatches.score > 0) {
                score += actionDescriptionMatches.score;
                actionDescriptionMatches.matchedTerms.forEach((term) => matchedTerms.add(term));
                matchSources.add('action_description');
            }

            const normalizedTypeName = normalizeSearchText(semanticType);
            if (normalizedTypeName === normalizedQuery) {
                score += 18;
                matchSources.add('type_name_phrase');
            } else if (normalizedTypeName.includes(normalizedQuery)) {
                score += 10;
                matchSources.add('type_name_phrase');
            }

            const normalizedDescription = normalizeSearchText(description);
            if (normalizedDescription.includes(normalizedQuery)) {
                score += 5;
                matchSources.add('type_description_phrase');
            }

            let inputNameFrequencyBonus = 0;
            for (const [inputName, count] of commonInputNames) {
                const normalizedInputName = normalizeSearchText(inputName);
                if (normalizedInputName === normalizedQuery) {
                    score += 14;
                    inputNameFrequencyBonus += Math.min(count, 6) * 3;
                    matchSources.add('input_name_phrase');
                    continue;
                }

                if (queryTokens.length > 1 && (
                    normalizedInputName.includes(normalizedQuery) || normalizedQuery.includes(normalizedInputName)
                )) {
                    score += 4;
                    inputNameFrequencyBonus += Math.min(count, 2);
                    matchSources.add('input_name_phrase');
                }
            }

            score += inputNameFrequencyBonus;

            if (score <= 0) continue;

            const dedupedConsumers = Array.from(
                new Map(consumers.map((consumer) => [`${consumer.plugin}:${consumer.action}`, consumer])).values()
            );

            const rankedInputNames = commonInputNames
                .sort((left, right) => {
                    const leftMatchesQuery = normalizeSearchText(left[0]).includes(normalizedQuery) ? 1 : 0;
                    const rightMatchesQuery = normalizeSearchText(right[0]).includes(normalizedQuery) ? 1 : 0;
                    return rightMatchesQuery - leftMatchesQuery || right[1] - left[1] || left[0].localeCompare(right[0]);
                })
                .slice(0, 5)
                .map(([inputName]) => inputName);

            candidates.push({
                semantic_type: semanticType,
                description,
                score,
                match_sources: [...matchSources].sort(),
                matched_terms: [...matchedTerms].sort(),
                common_input_names: rankedInputNames,
                consumers: dedupedConsumers,
            });
        }

        return candidates
            .sort((left, right) =>
                right.score - left.score
                || right.consumers.length - left.consumers.length
                || left.semantic_type.localeCompare(right.semantic_type)
            )
            .slice(0, limit);
    }

    findProducers(requiredTypes: string[], filters?: { distribution?: string, plugin?: string }) {
        const producers: { plugin: string, action: string }[] = [];
        const cleanTypes = requiredTypes.map((t) => t.trim()).filter((t) => t.length > 0);
        const pluginFilter = this.resolvePluginFilter(filters);

        if (cleanTypes.length === 0) {
            return producers;
        }
        
        for (const { plugin, action, details } of this.getAllActions()) {
            if (pluginFilter && !pluginFilter.has(plugin)) continue;
            if (!details.outputs) continue;
            
            const actionOutputs = Object.values(details.outputs);
            const outputUsage = new Array(actionOutputs.length).fill(0);
            
            let allMatched = true;

            for (const reqType of cleanTypes) {
                let matchedObj = false;

                for (let i = 0; i < actionOutputs.length; i++) {
                    const outputDef = actionOutputs[i] as any;
                    
                    if (outputUsage[i] > 0) continue; 

                    let typeCompatible = false;
                    if (outputDef.type) {
                        const outputTypes = Array.isArray(outputDef.type) ? outputDef.type : [outputDef.type];
                        for (const availType of outputTypes) {
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

            if (allMatched) {
                producers.push({ plugin, action });
            }
        }
        return producers;
    }

    planWorkflow(
        from: string[],
        to: string[],
        filters?: {
            distribution?: string,
            maxDepth?: number,
            includePlugins?: string[],
            excludePlugins?: string[],
        }
    ): MultiWorkflowPlan {
        const maxDepth = Math.min(filters?.maxDepth ?? 10, 50);
        const bfsPluginFilter = this.resolveBfsPluginFilter(filters);
        const includePreference = this.resolveIncludePreference(filters);
        const startTypes = new Set(from.map((t) => t.trim()).filter((t) => t.length > 0));
        const targetTypes = to.map((t) => t.trim()).filter((t) => t.length > 0);

        if (startTypes.size === 0 || targetTypes.length === 0) {
            return {
                steps: [],
                achieved_targets: [],
                missing_inputs: [...targetTypes],
                assumptions: [],
                warnings: ['No input or target types provided.'],
                available_types: [...startTypes],
            };
        }

        // Check which targets are already achievable from starting types
        if (targetTypes.every((t) => this.hasCompatibleType(startTypes, t))) {
            return {
                steps: [],
                achieved_targets: [...targetTypes],
                missing_inputs: [],
                assumptions: [],
                warnings: [],
                available_types: [...startTypes],
            };
        }

        // Phase 1: Forward BFS — discover which types become available at each depth
        const availableTypes = new Set(startTypes);
        const usedActions = new Set<string>();
        const actionDepth = new Map<string, number>();

        for (let depth = 0; depth < maxDepth; depth++) {
            const newTypes = new Set<string>();

            for (const { plugin, action, details } of this.getAllActions()) {
                if (bfsPluginFilter && !bfsPluginFilter.has(plugin)) continue;
                const key = toActionId(plugin, action);
                if (usedActions.has(key)) continue;
                if (!details.inputs) continue;

                const requiredInputs = Object.values(details.inputs)
                    .filter((inputDef) => inputDef.required);
                const allSatisfied = requiredInputs.every((inputDef) => {
                    const types = Array.isArray(inputDef.type) ? inputDef.type : [inputDef.type];
                    return types.some((reqType: string) => this.hasCompatibleType(availableTypes, reqType));
                });
                if (!allSatisfied) continue;

                usedActions.add(key);
                actionDepth.set(key, depth);

                if (details.outputs) {
                    for (const outputDef of Object.values(details.outputs)) {
                        const outputTypes = Array.isArray(outputDef.type) ? outputDef.type : [outputDef.type];
                        for (const outputType of outputTypes) {
                            if (!availableTypes.has(outputType)) {
                                newTypes.add(outputType);
                            }
                        }
                    }
                }
            }

            if (newTypes.size === 0) break;

            for (const outputType of newTypes) {
                availableTypes.add(outputType);
            }

            // When include_plugins is set, continue BFS to discover preferred plugin
            // actions even after all targets are reachable via other plugins
            if (!includePreference && targetTypes.every((t) => this.hasCompatibleType(availableTypes, t))) break;
        }

        // Phase 2: Backward reconstruction — trace from each target back to starting types
        // Uses plan-aware producer selection: prefers actions whose inputs are already
        // satisfied by the current plan, avoiding contrived paths through unrelated actions.
        const achievedTargets: string[] = [];
        const missingInputs: string[] = [];
        const neededActions = new Map<
            string,
            { plugin: string, action: string, depth: number, outputType: string, coveredTypes: Set<string> }
        >();

        for (const target of targetTypes) {
            if (this.hasCompatibleType(startTypes, target)) {
                achievedTargets.push(target);
                continue;
            }

            if (!this.hasCompatibleType(availableTypes, target)) {
                missingInputs.push(target);
                continue;
            }

            achievedTargets.push(target);
            this.traceBackward(target, startTypes, usedActions, actionDepth, bfsPluginFilter, includePreference, neededActions);
        }

        // Build plan entries for dependency analysis.
        // Use coveredTypes (the specific output types each entry was included to produce),
        // not all of an action's outputs. This prevents incidental outputs (e.g.
        // SampleData[Contigs % Properties('unbinned')] from binning) from being mistaken
        // as providers for unrelated upstream steps, while still allowing multi-port
        // actions (e.g. build_kraken_db covering both Kraken2DB and BrackenDB) to be
        // correctly found as predecessors for each of their outputs.
        const entries = [...neededActions.values()];
        const entryOutputTypes: string[][] = entries.map(({ coveredTypes }) => [...coveredTypes]);

        // Build dependency graph from actual plan steps (not BFS depths).
        // For each required input of entry i, find the plan entry with the
        // highest BFS depth that produces a compatible type — that is the
        // immediate predecessor for this input.
        const immediate: Set<number>[] = entries.map(() => new Set<number>());
        for (let i = 0; i < entries.length; i++) {
            const { plugin, action } = entries[i];
            const details = this.getAction(plugin, action);
            if (!details?.inputs) continue;

            for (const inputDef of Object.values(details.inputs)) {
                if (!inputDef.required) continue;
                const acceptedTypes = Array.isArray(inputDef.type) ? inputDef.type : [inputDef.type];

                // Only skip to startTypes if no plan step produces a compatible type.
                // When a plan step can directly satisfy this input (e.g. bin_contigs_metabat →
                // SampleData[MAGs] for sourmash:compute), prefer the plan step over startTypes so
                // that dependency chains are preserved even when startTypes happen to also satisfy
                // the input.
                //
                // We only check non-List accepted types here: List[T] inputs are satisfied by plan
                // entries (which produce T, not List[T]) only via List-lift, which is too broad and
                // creates false dependencies (e.g. classify_kraken2 accepting List[FeatureData[MAG]]
                // would otherwise pull in dereplicate_mags even for reads/contigs classification).
                const directAcceptedTypes = acceptedTypes.filter((t) => !t.trim().startsWith('List['));
                const hasPlanProducer = directAcceptedTypes.length > 0 && entries.some((_, j) =>
                    j !== i && entryOutputTypes[j].some((t) => directAcceptedTypes.some((req) => this.checkCompatibility(t, req)))
                );
                if (!hasPlanProducer && acceptedTypes.some((t) => this.hasCompatibleType(startTypes, t))) {
                    // Even when startTypes satisfies one variant of a multi-mode List input,
                    // check if a plan step provides a more specific variant whose inner type
                    // name aligns with this entry's output type.
                    // Example: classify_kraken2 for 'contigs' output should still depend on
                    // assembly (SampleData[Contigs]) even when reads are in startTypes.
                    const stopTokens = new Set(['sampledata', 'featuredata', 'properties']);
                    const tokenize = (s: string): Set<string> => new Set(
                        s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
                            .filter((t) => t.length > 3 && !stopTokens.has(t))
                    );
                    const outputTokens = tokenize(entries[i].outputType);
                    if (outputTokens.size > 0) {
                        for (const acceptedType of acceptedTypes) {
                            const trimmed = acceptedType.trim();
                            if (!trimmed.startsWith('List[') || !trimmed.endsWith(']')) continue;
                            const innerType = trimmed.slice(5, -1).trim();
                            if (this.hasCompatibleType(startTypes, innerType)) continue;
                            const innerTokens = tokenize(innerType);
                            if (innerTokens.size === 0 || ![...innerTokens].some((t) => outputTokens.has(t))) continue;
                            let bestJ = -1;
                            let bestDepth = -1;
                            for (let j = 0; j < entries.length; j++) {
                                if (j === i) continue;
                                if (entryOutputTypes[j].some((t) => this.checkCompatibility(t, innerType))) {
                                    if (entries[j].depth > bestDepth) { bestJ = j; bestDepth = entries[j].depth; }
                                }
                            }
                            if (bestJ >= 0) immediate[i].add(bestJ);
                        }
                    }
                    continue;
                }

                let bestJ = -1;
                let bestDepth = -1;
                for (let j = 0; j < entries.length; j++) {
                    if (j === i) continue;
                    if (entryOutputTypes[j].some((t) => acceptedTypes.some((req) => this.checkCompatibility(t, req)))) {
                        if (entries[j].depth > bestDepth) {
                            bestJ = j;
                            bestDepth = entries[j].depth;
                        }
                    }
                }
                if (bestJ >= 0) immediate[i].add(bestJ);
            }
        }

        // Topological sort (Kahn's algorithm), using BFS depth as tiebreaker
        // so that independent steps are still ordered deterministically.
        const inDegree = immediate.map((s) => s.size);
        const dependents: Set<number>[] = entries.map(() => new Set<number>());
        for (let i = 0; i < entries.length; i++) {
            for (const j of immediate[i]) dependents[j].add(i);
        }

        const ready = entries
            .map((_, i) => i)
            .filter((i) => inDegree[i] === 0)
            .sort((a, b) => entries[a].depth - entries[b].depth);

        const sortedIndices: number[] = [];
        while (ready.length > 0) {
            const i = ready.shift()!;
            sortedIndices.push(i);
            for (const j of dependents[i]) {
                if (--inDegree[j] === 0) {
                    const pos = ready.findIndex((k) => entries[k].depth > entries[j].depth);
                    pos === -1 ? ready.push(j) : ready.splice(pos, 0, j);
                }
            }
        }
        // Fallback: append any remaining entries in BFS-depth order (shouldn't happen)
        for (let i = 0; i < entries.length; i++) {
            if (!sortedIndices.includes(i)) sortedIndices.push(i);
        }

        const origToStepId = new Map(sortedIndices.map((orig, pos) => [orig, pos + 1]));

        const steps: WorkflowStep[] = sortedIndices.map((orig, pos) => ({
            step_id: pos + 1,
            action_id: toActionId(entries[orig].plugin, entries[orig].action),
            plugin: entries[orig].plugin,
            action: entries[orig].action,
            output_type: entries[orig].outputType,
            depends_on: [...immediate[orig]].map((j) => origToStepId.get(j)!).sort((a, b) => a - b),
        }));

        // Compute available types after running just the plan steps
        const planAvailableTypes = new Set(startTypes);
        for (const step of steps) {
            this.addAllActionOutputs(planAvailableTypes, step);
        }

        const warnings: string[] = [];
        if (missingInputs.length > 0) {
            warnings.push(`Could not find a path to produce: ${missingInputs.join(', ')}`);
        }

        return {
            steps,
            achieved_targets: achievedTargets,
            missing_inputs: missingInputs,
            assumptions: [],
            warnings,
            available_types: [...planAvailableTypes].sort(),
        };
    }

    private traceBackward(
        targetType: string,
        startTypes: Set<string>,
        usedActions: Set<string>,
        actionDepth: Map<string, number>,
        bfsPluginFilter: Set<string> | undefined,
        includePreference: Set<string> | undefined,
        neededActions: Map<string, { plugin: string, action: string, depth: number, outputType: string, coveredTypes: Set<string> }>
    ): void {
        const visited = new Set<string>();
        const queue: string[] = [targetType];

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current)) continue;
            visited.add(current);

            if (this.hasCompatibleType(startTypes, current)) continue;

            const best = this.selectBestProducer(
                (t) => this.checkCompatibility(t, current),
                startTypes, usedActions, actionDepth, bfsPluginFilter, includePreference, neededActions
            );
            if (!best) continue;

            const actionKey = toActionId(best.plugin, best.action);
            const stepKey = `${actionKey}::${current}`;
            if (neededActions.has(stepKey)) continue;

            // If this action is already in the plan and the current output comes
            // from a different port (free multi-port output), skip adding a new step.
            // Update the existing entry's coveredTypes so dep-graph building knows
            // this entry also produces the current type (e.g. build_kraken_db covers
            // both Kraken2DB and BrackenDB even though only one is stored as outputType).
            const bestDetails = this.getAction(best.plugin, best.action);
            if (bestDetails) {
                let freeFromExistingStep = false;
                const keyPrefix = actionKey + '::';
                for (const [entryKey, entry] of neededActions) {
                    if (!entryKey.startsWith(keyPrefix)) continue;
                    if (!this.outputTypesSharePort(bestDetails, current, entry.outputType)) {
                        entry.coveredTypes.add(current);
                        freeFromExistingStep = true;
                        break;
                    }
                }
                if (freeFromExistingStep) continue;
            }

            neededActions.set(stepKey, {
                plugin: best.plugin,
                action: best.action,
                depth: best.depth,
                outputType: current,
                coveredTypes: new Set([current]),
            });

            const actionDetails = this.getAction(best.plugin, best.action);
            if (!actionDetails?.inputs) continue;

            const currentDepth = best.depth;

            for (const inputDef of Object.values(actionDetails.inputs)) {
                if (!inputDef.required) continue;

                const acceptedTypes = Array.isArray(inputDef.type) ? inputDef.type : [inputDef.type];

                if (acceptedTypes.some((t: string) => this.hasCompatibleType(startTypes, t))) {
                    continue;
                }

                // Only consider outputs from actions at earlier depths to avoid
                // circular dependencies (an action's own outputs satisfying its inputs)
                const planAvailable = this.computePlanAvailableTypes(startTypes, neededActions, currentDepth);
                if (acceptedTypes.some((t: string) => this.hasCompatibleType(planAvailable, t))) {
                    continue;
                }

                const inputMatch = this.selectBestProducer(
                    (t) => acceptedTypes.some((req: string) => this.checkCompatibility(t, req)),
                    startTypes, usedActions, actionDepth, bfsPluginFilter, includePreference, neededActions
                );
                if (inputMatch) {
                    queue.push(inputMatch.producedType);
                }
            }
        }
    }

    private selectBestProducer(
        isCompatibleOutput: (producedType: string) => boolean,
        startTypes: Set<string>,
        usedActions: Set<string>,
        actionDepth: Map<string, number>,
        bfsPluginFilter: Set<string> | undefined,
        includePreference: Set<string> | undefined,
        neededActions: Map<string, { plugin: string, action: string, depth: number, outputType: string, coveredTypes: Set<string> }>
    ): { plugin: string, action: string, depth: number, producedType: string } | null {
        const planAvailable = this.computePlanAvailableTypes(startTypes, neededActions);

        let best: { plugin: string, action: string, depth: number, producedType: string } | null = null;
        let bestScore = -1;

        for (const { plugin, action, details } of this.getAllActions()) {
            if (bfsPluginFilter && !bfsPluginFilter.has(plugin)) continue;
            const key = toActionId(plugin, action);
            if (!usedActions.has(key)) continue;
            if (!details.outputs) continue;

            let matchedType: string | null = null;
            for (const outputDef of Object.values(details.outputs)) {
                const types = Array.isArray(outputDef.type) ? outputDef.type : [outputDef.type];
                for (const t of types) {
                    if (isCompatibleOutput(t)) { matchedType = t; break; }
                }
                if (matchedType) break;
            }
            if (!matchedType) continue;

            const depth = actionDepth.get(key) ?? 0;

            // Check if this action already has entries in neededActions
            const existingEntries: { outputType: string }[] = [];
            const keyPrefix = key + '::';
            for (const [entryKey, entry] of neededActions) {
                if (entryKey.startsWith(keyPrefix)) {
                    existingEntries.push(entry);
                }
            }

            if (existingEntries.length > 0) {
                // Self-circular check: don't use own output to satisfy own input
                const reqInputs = Object.values(details.inputs || {}).filter((i) => i.required);
                const selfCircular = reqInputs.some((inputDef) => {
                    const inputTypes = Array.isArray(inputDef.type) ? inputDef.type : [inputDef.type];
                    return inputTypes.some((t: string) => this.checkCompatibility(matchedType, t));
                });
                if (selfCircular) {
                    continue;
                }

                // Check if matched type needs a new invocation: it shares an output
                // port with an existing entry's output (union-typed port = one variant per invocation)
                const needsNewInvocation = existingEntries.some((entry) =>
                    matchedType !== entry.outputType &&
                    this.outputTypesSharePort(details, matchedType, entry.outputType)
                );

                if (!needsNewInvocation) {
                    // Free: either exact same output or from a different port
                    return { plugin, action, depth, producedType: matchedType };
                }
                // Same port, different variant — fall through to scoring as new invocation
            }

            // Score by fraction of required inputs already available from the plan
            const reqInputs = Object.values(details.inputs || {}).filter((i) => i.required);
            let score: number;
            if (reqInputs.length === 0) {
                score = 100;
            } else {
                const satisfied = reqInputs.filter((inputDef) => {
                    const types = Array.isArray(inputDef.type) ? inputDef.type : [inputDef.type];
                    return types.some((t: string) => this.hasCompatibleType(planAvailable, t));
                }).length;
                score = (satisfied / reqInputs.length) * 100;
            }

            // Boost score for actions from preferred (include_plugins) plugins
            if (includePreference && includePreference.has(plugin)) {
                score += 200;
            }

            if (score > bestScore || (score === bestScore && best !== null && depth < best.depth)) {
                best = { plugin, action, depth, producedType: matchedType };
                bestScore = score;
            }
        }

        return best;
    }

    private computePlanAvailableTypes(
        startTypes: Set<string>,
        neededActions: Map<string, { plugin: string, action: string, depth: number, outputType: string, coveredTypes: Set<string> }>,
        beforeDepth?: number
    ): Set<string> {
        const available = new Set(startTypes);
        for (const [, entry] of neededActions) {
            if (beforeDepth !== undefined && entry.depth >= beforeDepth) continue;
            const details = this.getAction(entry.plugin, entry.action);
            if (!details?.outputs) continue;
            for (const outputDef of Object.values(details.outputs)) {
                const types = Array.isArray(outputDef.type) ? outputDef.type : [outputDef.type];
                for (const t of types) available.add(t);
            }
        }
        return available;
    }

    private resolvePluginFilter(filters?: { distribution?: string, plugin?: string }): Set<string> | undefined {
        if (!filters?.distribution && !filters?.plugin) {
            return undefined;
        }

        let scopedPlugins: Set<string> | undefined;
        if (filters?.distribution) {
            const distKey = this.findKey(this.schema.distributions, filters.distribution);
            if (!distKey) {
                throw new Error(`Distribution '${filters.distribution}' not found.`);
            }

            scopedPlugins = new Set(
                this.schema.distributions[distKey].plugins
                    .map((pluginName) => this.findKey(this.schema.plugins, pluginName) || pluginName)
            );
        }

        if (filters?.plugin) {
            const pluginKey = this.findKey(this.schema.plugins, filters.plugin);
            if (!pluginKey) {
                throw new Error(`Plugin '${filters.plugin}' not found.`);
            }

            if (scopedPlugins && !scopedPlugins.has(pluginKey)) {
                return new Set();
            }
            return new Set([pluginKey]);
        }

        return scopedPlugins;
    }

    private resolveBfsPluginFilter(filters?: {
        distribution?: string,
        excludePlugins?: string[],
    }): Set<string> | undefined {
        let result = this.resolvePluginFilter(filters);

        if (filters?.excludePlugins && filters.excludePlugins.length > 0) {
            const excludeSet = new Set<string>();
            for (const name of filters.excludePlugins) {
                const key = this.findKey(this.schema.plugins, name);
                if (!key) throw new Error(`Plugin '${name}' not found.`);
                excludeSet.add(key);
            }
            if (result) {
                result = new Set([...result].filter((p) => !excludeSet.has(p)));
            } else {
                result = new Set(
                    Object.keys(this.schema.plugins).filter((p) => !excludeSet.has(p))
                );
            }
        }

        return result;
    }

    private resolveIncludePreference(filters?: {
        includePlugins?: string[],
    }): Set<string> | undefined {
        if (!filters?.includePlugins || filters.includePlugins.length === 0) {
            return undefined;
        }

        const includeSet = new Set<string>();
        for (const name of filters.includePlugins) {
            const key = this.findKey(this.schema.plugins, name);
            if (!key) throw new Error(`Plugin '${name}' not found.`);
            includeSet.add(key);
        }
        return includeSet;
    }

    private outputTypesSharePort(action: Action, typeA: string, typeB: string): boolean {
        if (!action.outputs) return false;
        for (const outputDef of Object.values(action.outputs)) {
            const types = Array.isArray(outputDef.type) ? outputDef.type : [outputDef.type];
            if (types.length <= 1) continue;
            const matchesA = types.some((t) =>
                this.checkCompatibility(t, typeA) || this.checkCompatibility(typeA, t)
            );
            const matchesB = types.some((t) =>
                this.checkCompatibility(t, typeB) || this.checkCompatibility(typeB, t)
            );
            if (matchesA && matchesB) return true;
        }
        return false;
    }

    // --- Compatibility Logic ---
    // Ported from Python: check_compatibility
    checkCompatibility(availType: string, reqType: string): boolean {
        return isTypeCompatible(availType, reqType);
    }
}
