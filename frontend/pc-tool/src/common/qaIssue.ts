export type QaIssueCode = 'INVALID_SIZE' | 'SIZE_PRIOR' | 'ASPECT' | 'OVERLAP';

export interface IQaIssue {
    frameId: string;
    frameName: string;
    objectUuid: string;
    objectId?: string;
    trackId?: string;
    label: string;
    message: string;
    code?: QaIssueCode;
}

export const QA_ISSUE_CODE_LABELS: Record<string, string> = {
    INVALID_SIZE: '尺寸异常',
    SIZE_PRIOR: '尺寸先验',
    ASPECT: '长宽比',
    OVERLAP: '重叠',
};

export const QA_ISSUE_FILTER_GROUPS: Array<{ id: string; label: string; codes?: QaIssueCode[] }> = [
    { id: 'ALL', label: '全部' },
    { id: 'INVALID_SIZE', label: '尺寸异常', codes: ['INVALID_SIZE'] },
    { id: 'SIZE_PRIOR', label: '尺寸先验', codes: ['SIZE_PRIOR'] },
    { id: 'ASPECT', label: '长宽比', codes: ['ASPECT'] },
    { id: 'SIZE', label: '尺寸相关', codes: ['INVALID_SIZE', 'SIZE_PRIOR', 'ASPECT'] },
    { id: 'OVERLAP', label: '重叠', codes: ['OVERLAP'] },
    { id: 'OTHER', label: '其他' },
];

export function getQaIssueCodeLabel(code?: string): string {
    if (!code) {
        return QA_ISSUE_CODE_LABELS.OTHER || '其他';
    }
    return QA_ISSUE_CODE_LABELS[code] || code;
}

export function matchQaIssueFilter(issue: IQaIssue, filterId: string): boolean {
    if (filterId === 'ALL') {
        return true;
    }
    if (filterId === 'OTHER') {
        return !issue.code;
    }
    const group = QA_ISSUE_FILTER_GROUPS.find((item) => item.id === filterId);
    if (!group?.codes) {
        return false;
    }
    return !!issue.code && group.codes.includes(issue.code);
}
