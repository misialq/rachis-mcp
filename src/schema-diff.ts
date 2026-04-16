import type { Action, Input, Output, Schema } from './types.js';
import { toActionId } from './action-utils.js';

function normalizeAction(action: Action): Action {
    const sortTypes = <T extends Input | Output>(field: T): T => ({
        ...field,
        type: [...field.type].sort(),
    });
    return {
        ...action,
        inputs: Object.fromEntries(Object.entries(action.inputs ?? {}).map(([k, v]) => [k, sortTypes(v)])),
        outputs: Object.fromEntries(Object.entries(action.outputs ?? {}).map(([k, v]) => [k, sortTypes(v)])),
    };
}

export interface FieldDiff {
    added: Record<string, unknown>;
    removed: Record<string, unknown>;
    modified: Record<string, { from: unknown; to: unknown }>;
}

export interface ActionChange {
    action_id: string;
    inputs?: FieldDiff;
    parameters?: FieldDiff;
    outputs?: FieldDiff;
    description?: { from: string; to: string };
}

export interface SchemaDiff {
    from_version: string;
    to_version: string;
    added: string[];
    removed: string[];
    changed: ActionChange[];
    summary: string;
}

function diffRecords<T>(from: Record<string, T>, to: Record<string, T>): FieldDiff | undefined {
    const added: Record<string, T> = {};
    const removed: Record<string, T> = {};
    const modified: Record<string, { from: T; to: T }> = {};

    for (const key of Object.keys(to)) {
        if (!(key in from)) {
            added[key] = to[key];
        } else if (JSON.stringify(from[key]) !== JSON.stringify(to[key])) {
            modified[key] = { from: from[key], to: to[key] };
        }
    }

    for (const key of Object.keys(from)) {
        if (!(key in to)) {
            removed[key] = from[key];
        }
    }

    if (
        Object.keys(added).length === 0 &&
        Object.keys(removed).length === 0 &&
        Object.keys(modified).length === 0
    ) {
        return undefined;
    }

    return { added, removed, modified };
}

function diffActions(from: Action, to: Action): Omit<ActionChange, 'action_id'> | undefined {
    const changes: Omit<ActionChange, 'action_id'> = {};

    const inputsDiff = diffRecords(from.inputs ?? {}, to.inputs ?? {});
    if (inputsDiff) changes.inputs = inputsDiff;

    const paramsDiff = diffRecords(from.parameters ?? {}, to.parameters ?? {});
    if (paramsDiff) changes.parameters = paramsDiff;

    const outputsDiff = diffRecords(from.outputs ?? {}, to.outputs ?? {});
    if (outputsDiff) changes.outputs = outputsDiff;

    if (from.description !== to.description) {
        changes.description = { from: from.description, to: to.description };
    }

    return Object.keys(changes).length > 0 ? changes : undefined;
}

function buildSummary(
    fromVersion: string,
    toVersion: string,
    added: string[],
    removed: string[],
    changed: ActionChange[]
): string {
    const fmt = (id: string) => {
        const [plugin, action] = id.split(':');
        return `\`${toActionId(plugin, action)}\``;
    };

    const lines: string[] = [`## Rachis ${fromVersion} → ${toVersion}`];

    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
        lines.push('\nNo changes detected.');
        return lines.join('\n');
    }

    if (added.length > 0) {
        lines.push(`\n### New actions (${added.length})`);
        for (const id of added) lines.push(`- ${fmt(id)}`);
    }

    if (removed.length > 0) {
        lines.push(`\n### Removed actions (${removed.length})`);
        for (const id of removed) lines.push(`- ${fmt(id)}`);
    }

    if (changed.length > 0) {
        lines.push(`\n### Changed actions (${changed.length})`);
        for (const { action_id, inputs, parameters, outputs, description } of changed) {
            lines.push(`\n#### ${fmt(action_id)}`);
            for (const [label, diff] of [
                ['input', inputs],
                ['parameter', parameters],
                ['output', outputs],
            ] as [string, FieldDiff | undefined][]) {
                if (!diff) continue;
                const a = Object.keys(diff.added);
                const r = Object.keys(diff.removed);
                const m = Object.keys(diff.modified);
                if (a.length) lines.push(`- Added ${label}(s): ${a.map((v) => `\`${v}\``).join(', ')}`);
                if (r.length) lines.push(`- Removed ${label}(s): ${r.map((v) => `\`${v}\``).join(', ')}`);
                if (m.length) lines.push(`- Changed ${label}(s): ${m.map((v) => `\`${v}\``).join(', ')}`);
            }
            if (description) lines.push(`- Description updated`);
        }
    }

    return lines.join('\n');
}

export function diffSchemas(
    fromSchema: Schema,
    toSchema: Schema,
    fromVersion: string,
    toVersion: string
): SchemaDiff {
    const fromActions = new Map<string, Action>();
    for (const [plugin, { actions }] of Object.entries(fromSchema.plugins)) {
        for (const [action, def] of Object.entries(actions)) {
            fromActions.set(toActionId(plugin, action), normalizeAction(def));
        }
    }

    const toActions = new Map<string, Action>();
    for (const [plugin, { actions }] of Object.entries(toSchema.plugins)) {
        for (const [action, def] of Object.entries(actions)) {
            toActions.set(toActionId(plugin, action), normalizeAction(def));
        }
    }

    const added: string[] = [];
    const removed: string[] = [];
    const changed: ActionChange[] = [];

    for (const [id, toAction] of toActions) {
        const fromAction = fromActions.get(id);
        if (!fromAction) {
            added.push(id);
        } else {
            const diff = diffActions(fromAction, toAction);
            if (diff) changed.push({ action_id: id, ...diff });
        }
    }

    for (const id of fromActions.keys()) {
        if (!toActions.has(id)) removed.push(id);
    }

    const sortedAdded = added.sort();
    const sortedRemoved = removed.sort();
    const sortedChanged = changed.sort((a, b) => a.action_id.localeCompare(b.action_id));

    return {
        from_version: fromVersion,
        to_version: toVersion,
        added: sortedAdded,
        removed: sortedRemoved,
        changed: sortedChanged,
        summary: buildSummary(fromVersion, toVersion, sortedAdded, sortedRemoved, sortedChanged),
    };
}
