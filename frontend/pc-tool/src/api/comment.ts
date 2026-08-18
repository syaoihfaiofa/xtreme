import { get, post } from './base';
import type {
    DiscussionAnchorType,
    IDiscussionComment,
    IDiscussionPosition,
} from '../components/Discussion/store';

export interface ICreateDiscussionComment {
    datasetId: string;
    dataId: string;
    anchorType: DiscussionAnchorType;
    objectId?: string;
    trackId?: string;
    position?: IDiscussionPosition;
    parentId?: string;
    message: string;
}

function normalize(comment: any): IDiscussionComment {
    return {
        ...comment,
        id: String(comment.id),
        datasetId: String(comment.datasetId),
        dataId: String(comment.dataId),
        objectId: comment.objectId == null ? undefined : String(comment.objectId),
        parentId: comment.parentId == null ? undefined : String(comment.parentId),
        rootId: comment.rootId == null ? undefined : String(comment.rootId),
        createdBy: comment.author?.id == null ? undefined : String(comment.author.id),
        authorName: comment.author?.nickname || comment.author?.username,
    };
}

export async function listComments(
    datasetId: string,
    dataIds: string[],
): Promise<IDiscussionComment[]> {
    const response: any = await get('/api/annotate/comment/listByDataIds', {
        datasetId,
        dataIds: dataIds.join(','),
    });
    return (response?.data || []).map(normalize);
}

export async function createComment(
    payload: ICreateDiscussionComment,
): Promise<IDiscussionComment> {
    const response: any = payload.parentId
        ? await post('/api/annotate/comment/reply', {
              datasetId: payload.datasetId,
              dataId: payload.dataId,
              parentId: payload.parentId,
              message: payload.message,
          })
        : await post('/api/annotate/comment/create', payload);
    return normalize(response?.data);
}

export async function setCommentResolved(
    comment: Pick<IDiscussionComment, 'id' | 'datasetId' | 'dataId'>,
    resolved: boolean,
): Promise<void> {
    await post(
        `/api/annotate/comment/${comment.id}/${resolved ? 'resolve' : 'reopen'}`,
        null,
        { params: { datasetId: comment.datasetId, dataId: comment.dataId } },
    );
}

export async function deleteComment(
    comment: Pick<IDiscussionComment, 'id' | 'datasetId' | 'dataId'>,
): Promise<void> {
    await post(`/api/annotate/comment/${comment.id}/delete`, null, {
        params: { datasetId: comment.datasetId, dataId: comment.dataId },
    });
}
