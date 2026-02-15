export interface ParsedSemanticType {
    raw: string;
    head: string;
    args: ParsedSemanticType[];
    propertyOptions: Array<Set<string>>;
}

const parseCache = new Map<string, ParsedSemanticType>();

const isEscaped = (value: string, index: number): boolean => {
    let backslashCount = 0;
    for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) {
        backslashCount++;
    }
    return backslashCount % 2 === 1;
};

const splitTopLevel = (value: string, delimiter: string): string[] => {
    const parts: string[] = [];
    let current = '';
    let squareDepth = 0;
    let parenDepth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < value.length; i++) {
        const char = value[i];

        if (char === "'" && !inDoubleQuote && !isEscaped(value, i)) {
            inSingleQuote = !inSingleQuote;
            current += char;
            continue;
        }

        if (char === '"' && !inSingleQuote && !isEscaped(value, i)) {
            inDoubleQuote = !inDoubleQuote;
            current += char;
            continue;
        }

        if (!inSingleQuote && !inDoubleQuote) {
            if (char === '[') squareDepth++;
            if (char === ']') squareDepth--;
            if (char === '(') parenDepth++;
            if (char === ')') parenDepth--;

            if (char === delimiter && squareDepth === 0 && parenDepth === 0) {
                parts.push(current.trim());
                current = '';
                continue;
            }
        }

        current += char;
    }

    if (current.trim().length > 0) {
        parts.push(current.trim());
    }

    return parts;
};

const findTopLevelChar = (value: string, target: string): number => {
    let squareDepth = 0;
    let parenDepth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < value.length; i++) {
        const char = value[i];

        if (char === "'" && !inDoubleQuote && !isEscaped(value, i)) {
            inSingleQuote = !inSingleQuote;
            continue;
        }

        if (char === '"' && !inSingleQuote && !isEscaped(value, i)) {
            inDoubleQuote = !inDoubleQuote;
            continue;
        }

        if (inSingleQuote || inDoubleQuote) continue;

        if (char === target && squareDepth === 0 && parenDepth === 0) {
            return i;
        }

        if (char === '[') squareDepth++;
        if (char === ']') squareDepth--;
        if (char === '(') parenDepth++;
        if (char === ')') parenDepth--;
    }

    return -1;
};

const stripOuterParens = (value: string): string => {
    const trimmed = value.trim();
    if (!(trimmed.startsWith('(') && trimmed.endsWith(')'))) return trimmed;

    let depth = 0;
    for (let i = 0; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (depth === 0 && i < trimmed.length - 1) return trimmed;
    }

    return trimmed.slice(1, -1).trim();
};

const stripQuotes = (value: string): string => {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === "'" || first === '"') && first === last) {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
};

const parsePropertiesCall = (value: string): Set<string> | null => {
    const trimmed = value.trim();
    if (!trimmed.startsWith('Properties(') || !trimmed.endsWith(')')) {
        return null;
    }

    const inner = trimmed.slice('Properties('.length, -1).trim();
    if (inner.length === 0) {
        return new Set<string>();
    }

    const props = splitTopLevel(inner, ',').map(stripQuotes).filter((prop) => prop.length > 0);
    return new Set(props);
};

const parsePropertyOptions = (value: string | undefined): Array<Set<string>> => {
    if (!value || value.trim().length === 0) {
        return [new Set<string>()];
    }

    const trimmed = value.trim();
    const directProperties = parsePropertiesCall(trimmed);
    if (directProperties) {
        return [directProperties];
    }

    const unwrapped = stripOuterParens(trimmed);
    const options = splitTopLevel(unwrapped, '|')
        .map((option) => parsePropertiesCall(option))
        .filter((option): option is Set<string> => option !== null);

    if (options.length > 0) {
        return options;
    }

    return [new Set<string>()];
};

const parseHeadAndArgs = (value: string): { head: string, args: ParsedSemanticType[] } => {
    const trimmed = value.trim();
    const openBracketIndex = findTopLevelChar(trimmed, '[');
    if (openBracketIndex === -1) {
        return { head: trimmed, args: [] };
    }

    const head = trimmed.slice(0, openBracketIndex).trim();
    let bracketDepth = 0;
    let closeBracketIndex = -1;
    for (let i = openBracketIndex; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (char === '[') bracketDepth++;
        if (char === ']') bracketDepth--;
        if (bracketDepth === 0) {
            closeBracketIndex = i;
            break;
        }
    }

    if (closeBracketIndex === -1) {
        return { head: trimmed, args: [] };
    }

    const argsSection = trimmed.slice(openBracketIndex + 1, closeBracketIndex).trim();
    if (argsSection.length === 0) {
        return { head, args: [] };
    }

    const args = splitTopLevel(argsSection, ',').map((arg) => parseSemanticType(arg));
    return { head, args };
};

const splitTopLevelUnion = (value: string): string[] => splitTopLevel(value.trim(), '|');

export const parseSemanticType = (value: string): ParsedSemanticType => {
    const normalized = value.trim();
    const cached = parseCache.get(normalized);
    if (cached) {
        return cached;
    }

    const percentIndex = findTopLevelChar(normalized, '%');
    const baseType = percentIndex === -1 ? normalized : normalized.slice(0, percentIndex).trim();
    const propertyExpression = percentIndex === -1 ? undefined : normalized.slice(percentIndex + 1).trim();

    const { head, args } = parseHeadAndArgs(baseType);
    const parsed: ParsedSemanticType = {
        raw: normalized,
        head,
        args,
        propertyOptions: parsePropertyOptions(propertyExpression),
    };

    parseCache.set(normalized, parsed);
    return parsed;
};

const isPropertySetCompatible = (available: Set<string>, required: Set<string>): boolean => {
    for (const requiredProperty of required) {
        if (!available.has(requiredProperty)) {
            return false;
        }
    }
    return true;
};

const arePropertyOptionsCompatible = (
    availableOptions: Array<Set<string>>,
    requiredOptions: Array<Set<string>>
): boolean => {
    for (const requiredOption of requiredOptions) {
        for (const availableOption of availableOptions) {
            if (isPropertySetCompatible(availableOption, requiredOption)) {
                return true;
            }
        }
    }
    return false;
};

const isParsedCompatible = (available: ParsedSemanticType, required: ParsedSemanticType): boolean => {
    if (available.head !== required.head) {
        return false;
    }

    if (required.args.length > 0) {
        if (available.args.length < required.args.length) {
            return false;
        }

        for (let i = 0; i < required.args.length; i++) {
            if (!isParsedCompatible(available.args[i], required.args[i])) {
                return false;
            }
        }
    }

    return arePropertyOptionsCompatible(available.propertyOptions, required.propertyOptions);
};

const unwrapList = (value: string): string | null => {
    const parsed = parseSemanticType(value);
    if (parsed.head !== 'List' || parsed.args.length !== 1) {
        return null;
    }
    return parsed.args[0].raw;
};

export const isTypeCompatible = (availableType: string, requiredType: string): boolean => {
    const available = availableType.trim();
    const required = requiredType.trim();

    // Preserve prior behavior: T can satisfy List[T].
    if (!available.startsWith('List[') && required.startsWith('List[')) {
        const listInnerType = unwrapList(required);
        if (listInnerType && isTypeCompatible(available, listInnerType)) {
            return true;
        }
    }

    const requiredVariants = splitTopLevelUnion(required);
    if (requiredVariants.length > 1) {
        return requiredVariants.some((variant) => isTypeCompatible(available, variant));
    }

    const availableVariants = splitTopLevelUnion(available);
    if (availableVariants.length > 1) {
        return availableVariants.some((variant) => isTypeCompatible(variant, required));
    }

    return isParsedCompatible(parseSemanticType(available), parseSemanticType(required));
};
