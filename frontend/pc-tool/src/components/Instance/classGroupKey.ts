export function getClassGroupKey(
    classify: string,
    classId: string | number | null | undefined,
    classType: string,
): string {
    return `${classify}${classId ?? classType}`;
}
