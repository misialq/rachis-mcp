import type { Action, Parameter, Schema } from './types.js';
import { isTypeCompatible, parseSemanticType, type ParsedSemanticType } from './semantic-type.js';

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

    // --- Compatibility Logic ---
    // Ported from Python: check_compatibility
    checkCompatibility(availType: string, reqType: string): boolean {
        return isTypeCompatible(availType, reqType);
    }
}
