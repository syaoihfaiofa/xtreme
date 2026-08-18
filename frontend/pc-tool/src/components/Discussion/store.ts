import { reactive } from 'vue';

export type DiscussionAnchorType = 'FRAME' | 'OBJECT' | 'POSITION';

export interface IDiscussionPosition {
    x: number;
    y: number;
    z: number;
}

export interface IDiscussionComment {
    id: string;
    datasetId: string;
    dataId: string;
    anchorType: DiscussionAnchorType;
    objectId?: string;
    trackId?: string;
    position?: IDiscussionPosition;
    message: string;
    parentId?: string;
    rootId?: string;
    resolved: boolean;
    createdBy?: string;
    authorName?: string;
    createdAt?: string;
    replies?: IDiscussionComment[];
}

export const discussionState = reactive({
    comments: [] as IDiscussionComment[],
    activeCommentId: '',
    loading: false,
});

export function setDiscussionComments(comments: IDiscussionComment[]) {
    discussionState.comments = comments;
}
