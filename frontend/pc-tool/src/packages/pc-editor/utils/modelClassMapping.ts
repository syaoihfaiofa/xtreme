import { IClassType } from '../type';

// Model class codes whose wording differs from dataset class names beyond case and
// punctuation, keyed and valued by compact keys (see compactClassKey).
const MODEL_CLASS_ALIASES: Record<string, string> = {
    boardnoparking: 'noparkingboard',
    bike: 'bicycle',
};

// Distinct non-white colors for model classes that match no dataset class.
const UNMAPPED_MODEL_CLASS_COLORS: readonly string[] = [
    '#e6194b',
    '#3cb44b',
    '#ffe119',
    '#4363d8',
    '#f58231',
    '#911eb4',
    '#42d4f4',
    '#f032e6',
    '#bfef45',
    '#fabed4',
    '#469990',
    '#9a6324',
];

export function compactClassKey(name: string | number): string {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function buildClassAliasMap(classTypes: IClassType[]): Map<string, IClassType> {
    const aliasMap = new Map<string, IClassType>();
    classTypes.forEach((classType) => {
        const key = compactClassKey(classType.name + '');
        if (key && !aliasMap.has(key)) aliasMap.set(key, classType);
    });
    return aliasMap;
}

export function findClassTypeByModelClass(
    aliasMap: Map<string, IClassType>,
    modelClass: string | undefined,
): IClassType | undefined {
    if (!modelClass) return undefined;
    const key = compactClassKey(modelClass);
    if (!key) return undefined;
    const alias = MODEL_CLASS_ALIASES[key];
    return aliasMap.get(key) || (alias ? aliasMap.get(alias) : undefined);
}

export function getUnmappedModelClassColor(modelClass: string | undefined): string | undefined {
    if (!modelClass) return undefined;
    let hash = 0;
    for (let index = 0; index < modelClass.length; index++) {
        hash = (hash * 31 + modelClass.charCodeAt(index)) >>> 0;
    }
    return UNMAPPED_MODEL_CLASS_COLORS[hash % UNMAPPED_MODEL_CLASS_COLORS.length];
}
