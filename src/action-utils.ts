export const toActionId = (plugin: string, action: string): string => `${plugin}:${action}`;

export const normalizeActionIds = (actionIds: Iterable<string>): string[] => {
    const normalized = Array.from(
        new Set(
            Array.from(actionIds)
                .map((actionId) => actionId.trim())
                .filter((actionId) => actionId.length > 0)
        )
    );

    return normalized.sort((a, b) => a.localeCompare(b));
};

