export interface SizePriorRange {
    min: number;
    max: number;
}

export interface ClassSizePrior {
    length: SizePriorRange;
    width: SizePriorRange;
    height: SizePriorRange;
}

export interface AnnotationDataCheckJsonConfig {
    minDim: number;
    iouThreshold: number;
    longAxisClasses: string[];
    classAliases?: Record<string, string>;
    overlapSkipPairs: [string, string][];
    sizePrior: Record<string, ClassSizePrior>;
}

export interface AnnotationDataCheckRuntimeConfig {
    minDim: number;
    iouThreshold: number;
    longAxisClasses: Set<string>;
    classAliases: Record<string, string>;
    overlapSkipPairs: Set<string>;
    sizePrior: Record<string, ClassSizePrior>;
}

function overlapPairKey(leftClass: string, rightClass: string): string {
    const pair = [leftClass, rightClass].sort();
    return `${pair[0]}::${pair[1]}`;
}

export function buildAnnotationDataCheckConfig(
    json: AnnotationDataCheckJsonConfig,
): AnnotationDataCheckRuntimeConfig {
    return {
        minDim: json.minDim,
        iouThreshold: json.iouThreshold,
        longAxisClasses: new Set(json.longAxisClasses.map((name) => name.trim().toLowerCase())),
        classAliases: Object.fromEntries(
            Object.entries(json.classAliases || {}).map(([alias, canonical]) => [
                alias.trim().toLowerCase(),
                canonical.trim().toLowerCase(),
            ]),
        ),
        overlapSkipPairs: new Set(
            json.overlapSkipPairs.map(([left, right]) =>
                overlapPairKey(left.trim().toLowerCase(), right.trim().toLowerCase()),
            ),
        ),
        sizePrior: Object.fromEntries(
            Object.entries(json.sizePrior).map(([className, prior]) => [
                className.trim().toLowerCase(),
                prior,
            ]),
        ),
    };
}
