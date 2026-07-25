import { z } from 'zod';

import { PlanSchema, validateAcyclicPlan } from './domain.js';

/** Maximum UTF-8 size accepted for a goal-plan Markdown document (1 MiB). */
export const MAX_GOAL_PLAN_MARKDOWN_BYTES = 1_024 * 1_024;

const MAX_JSON_DEPTH = 64;

const invalidGoalPlanJson = (message: string): never => {
    throw new Error(`Invalid goal-plan JSON: ${message}`);
};

export const GoalPlanInputSchema = z
    .object({
        objective: PlanSchema.shape.objective,
        units: PlanSchema.shape.units,
        finalVerificationRequirements:
            PlanSchema.shape.finalVerificationRequirements.default([]),
        authoredBy: PlanSchema.shape.authoredBy,
    })
    .strict();

export type GoalPlanInput = Readonly<z.output<typeof GoalPlanInputSchema>>;

type Fence = {
    readonly marker: '`' | '~';
    readonly length: number;
    readonly info: string;
};

const openingFence = (line: string): Fence | undefined => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!match?.[1]) return undefined;
    const marker = match[1][0] as Fence['marker'];
    const info = (match[2] ?? '').trim();
    if (marker === '`' && info.includes('`')) {
        if (/\bgoal-plan\b/u.test(info)) {
            throw new Error('Malformed goal-plan fence.');
        }
        return undefined;
    }
    return { marker, length: match[1].length, info };
};

const isClosingFence = (line: string, fence: Fence): boolean => {
    const match = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line);
    return Boolean(
        match?.[1] &&
        match[1][0] === fence.marker &&
        match[1].length >= fence.length,
    );
};

const extractGoalPlanJson = (markdown: string): string => {
    const lines = markdown.split(/\r\n|\n|\r/u);
    let open:
        | (Fence & {
              readonly goalPlan: boolean;
              readonly content: string[];
          })
        | undefined;
    let goalPlanJson: string | undefined;

    for (const line of lines) {
        if (open) {
            if (isClosingFence(line, open)) {
                if (open.goalPlan) goalPlanJson = open.content.join('\n');
                open = undefined;
                continue;
            }
            if (open.goalPlan && openingFence(line)?.info === 'goal-plan') {
                throw new Error(
                    'Goal-plan Markdown must contain exactly one goal-plan block.',
                );
            }
            if (open.goalPlan) open.content.push(line);
            continue;
        }

        const fence = openingFence(line);
        if (!fence) continue;
        if (/\bgoal-plan\b/u.test(fence.info) && fence.info !== 'goal-plan') {
            throw new Error(
                "A goal-plan fence's info string must be exactly 'goal-plan'.",
            );
        }
        const goalPlan = fence.info === 'goal-plan';
        if (goalPlan && goalPlanJson !== undefined) {
            throw new Error(
                'Goal-plan Markdown must contain exactly one goal-plan block.',
            );
        }
        open = { ...fence, goalPlan, content: [] };
    }

    if (open) {
        throw new Error(
            open.goalPlan
                ? 'Goal-plan fence is unclosed.'
                : 'Markdown code fence is unclosed.',
        );
    }
    if (goalPlanJson === undefined) {
        throw new Error(
            'Goal-plan Markdown must contain exactly one goal-plan block.',
        );
    }
    return goalPlanJson;
};

const parseJsonWithoutDuplicateKeys = (source: string): unknown => {
    let index = 0;

    const skipWhitespace = (): void => {
        while (
            source[index] === ' ' ||
            source[index] === '\t' ||
            source[index] === '\n' ||
            source[index] === '\r'
        ) {
            index += 1;
        }
    };
    const parseString = (): string => {
        const start = index;
        if (source[index] !== '"')
            invalidGoalPlanJson('expected a JSON string.');
        index += 1;
        while (index < source.length) {
            const character = source[index]!;
            if (character === '"') {
                index += 1;
                try {
                    return JSON.parse(source.slice(start, index)) as string;
                } catch {
                    invalidGoalPlanJson('invalid JSON string.');
                }
            }
            if (character === '\\') {
                index += 1;
                const escape = source[index];
                if (!escape) invalidGoalPlanJson('unterminated JSON string.');
                if (escape === 'u') {
                    if (
                        !/^[0-9a-fA-F]{4}$/u.test(
                            source.slice(index + 1, index + 5),
                        )
                    ) {
                        invalidGoalPlanJson('invalid Unicode escape.');
                    }
                    index += 5;
                    continue;
                }
                if (!'"\\/bfnrt'.includes(escape)) {
                    invalidGoalPlanJson('invalid JSON escape.');
                }
                index += 1;
                continue;
            }
            if (character.charCodeAt(0) < 0x20) {
                invalidGoalPlanJson('unescaped control character in a string.');
            }
            index += 1;
        }
        return invalidGoalPlanJson('unterminated JSON string.');
    };
    const parseValue = (depth: number): void => {
        if (depth > MAX_JSON_DEPTH) {
            invalidGoalPlanJson(
                `JSON nesting exceeds ${MAX_JSON_DEPTH} levels.`,
            );
        }
        skipWhitespace();
        const character = source[index];
        if (character === '{') {
            index += 1;
            skipWhitespace();
            const keys = new Set<string>();
            if (source[index] === '}') {
                index += 1;
                return;
            }
            while (index < source.length) {
                skipWhitespace();
                const key = parseString();
                if (keys.has(key)) {
                    invalidGoalPlanJson(
                        `duplicate object key ${JSON.stringify(key.slice(0, 80))}.`,
                    );
                }
                keys.add(key);
                skipWhitespace();
                if (source[index] !== ':')
                    invalidGoalPlanJson("expected ':' after an object key.");
                index += 1;
                parseValue(depth + 1);
                skipWhitespace();
                if (source[index] === '}') {
                    index += 1;
                    return;
                }
                if (source[index] !== ',') {
                    invalidGoalPlanJson("expected ',' or '}' in an object.");
                }
                index += 1;
            }
            invalidGoalPlanJson('unterminated object.');
        }
        if (character === '[') {
            index += 1;
            skipWhitespace();
            if (source[index] === ']') {
                index += 1;
                return;
            }
            while (index < source.length) {
                parseValue(depth + 1);
                skipWhitespace();
                if (source[index] === ']') {
                    index += 1;
                    return;
                }
                if (source[index] !== ',') {
                    invalidGoalPlanJson("expected ',' or ']' in an array.");
                }
                index += 1;
            }
            invalidGoalPlanJson('unterminated array.');
        }
        if (character === '"') {
            parseString();
            return;
        }
        for (const literal of ['true', 'false', 'null']) {
            if (source.startsWith(literal, index)) {
                index += literal.length;
                return;
            }
        }
        const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
            source.slice(index),
        )?.[0];
        if (number) {
            index += number.length;
            return;
        }
        invalidGoalPlanJson('expected a JSON value.');
    };

    parseValue(0);
    skipWhitespace();
    if (index !== source.length)
        invalidGoalPlanJson('unexpected trailing content.');
    try {
        return JSON.parse(source) as unknown;
    } catch {
        return invalidGoalPlanJson('malformed JSON.');
    }
};

export const parseGoalPlanMarkdown = (markdown: string): GoalPlanInput => {
    if (typeof markdown !== 'string') {
        throw new Error('Goal-plan Markdown must be a string.');
    }
    const byteLength = Buffer.byteLength(markdown, 'utf8');
    if (byteLength > MAX_GOAL_PLAN_MARKDOWN_BYTES) {
        throw new Error(
            `Goal-plan Markdown exceeds the ${MAX_GOAL_PLAN_MARKDOWN_BYTES}-byte limit.`,
        );
    }
    if (markdown.includes('\0')) {
        throw new Error('Goal-plan Markdown may not contain NUL characters.');
    }

    const value = parseJsonWithoutDuplicateKeys(extractGoalPlanJson(markdown));
    const parsed = GoalPlanInputSchema.safeParse(value);
    if (!parsed.success) {
        const details = parsed.error.issues
            .map(issue => {
                const path =
                    issue.path.length > 0 ? issue.path.join('.') : 'plan';
                return `${path}: ${issue.message}`;
            })
            .join('; ');
        throw new Error(`Invalid goal-plan: ${details}`);
    }
    const issues = validateAcyclicPlan(parsed.data);
    if (issues.length > 0) {
        throw new Error(
            `Invalid goal-plan: ${issues.map(issue => issue.message).join('; ')}`,
        );
    }
    return parsed.data;
};
