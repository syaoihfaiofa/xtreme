<template>
    <div class="discussion-panel">
        <div class="discussion-header">
            <strong>Discussion</strong>
            <span>Read-only annotations</span>
        </div>

        <div class="selected-annotation">
            <template v-if="selectedAnnotation">
                <div class="selected-title">Selected Annotation</div>
                <div>
                    <span>Category</span>
                    <strong>{{ selectedAnnotation.category }}</strong>
                </div>
                <div>
                    <span>Track ID</span>
                    <strong>{{ selectedAnnotation.trackId || '-' }}</strong>
                </div>
            </template>
            <span v-else class="no-selection">Select an annotation to inspect its category</span>
        </div>

        <div class="discussion-compose">
            <div class="anchor-buttons">
                <a-button size="small" :type="anchorType === 'FRAME' ? 'primary' : 'default'" @click="useFrame">
                    Frame
                </a-button>
                <a-button size="small" :type="anchorType === 'OBJECT' ? 'primary' : 'default'" @click="useSelectedObject">
                    Selected object
                </a-button>
                <a-button size="small" :type="anchorType === 'POSITION' ? 'primary' : 'default'" @click="pickAnchor">
                    Pick point
                </a-button>
            </div>
            <div class="anchor-summary">{{ anchorSummary }}</div>
            <a-textarea
                v-model:value="draft"
                :rows="3"
                :maxlength="2000"
                placeholder="Discuss annotation quality..."
            />
            <a-button type="primary" block :loading="submitting" :disabled="!draft.trim()" @click="submitRoot">
                Add comment
            </a-button>
        </div>

        <div class="discussion-filter">
            <span>{{ currentThreads.length }} thread(s) on this frame</span>
            <a-checkbox v-model:checked="showResolved">Show resolved</a-checkbox>
        </div>
        <div class="comment-frame-filter">
            <span>
                <strong>Only Commented Frames</strong>
                <small>Keep timeline positions and skip frames without comments</small>
            </span>
            <a-switch
                :checked="editor.state.config.filterFramesByComment"
                @change="onCommentFrameFilterChange"
            />
        </div>

        <a-spin :spinning="discussionState.loading">
            <div v-if="visibleThreads.length === 0" class="discussion-empty">No comments on this frame</div>
            <div
                v-for="thread in visibleThreads"
                :key="thread.id"
                class="discussion-thread"
                :class="{ active: discussionState.activeCommentId === thread.id, resolved: thread.resolved }"
                @click="focusThread(thread)"
            >
                <div class="thread-meta">
                    <span class="anchor-kind">{{ anchorLabel(thread) }}</span>
                    <span>{{ thread.authorName || `User ${thread.createdBy || ''}` }}</span>
                    <span>{{ formatTime(thread.createdAt) }}</span>
                </div>
                <div class="thread-message">{{ thread.message }}</div>
                <div v-if="thread.anchorType === 'OBJECT' && !findAnchorObject(thread)" class="missing-anchor">
                    Target no longer exists
                </div>
                <div v-for="reply in repliesOf(thread)" :key="reply.id" class="discussion-reply">
                    <div class="thread-meta">
                        <span>{{ reply.authorName || `User ${reply.createdBy || ''}` }}</span>
                        <span>{{ formatTime(reply.createdAt) }}</span>
                    </div>
                    <div>{{ reply.message }}</div>
                    <div class="reply-actions" @click.stop>
                        <a-button type="link" size="small" danger @click="deleteComment(reply)">
                            Delete
                        </a-button>
                    </div>
                </div>
                <div class="thread-actions" @click.stop>
                    <a-button type="link" size="small" @click="toggleReply(thread.id)">Reply</a-button>
                    <a-button type="link" size="small" @click="setResolved(thread, !thread.resolved)">
                        {{ thread.resolved ? 'Reopen' : 'Resolve' }}
                    </a-button>
                    <a-button type="link" size="small" danger @click="deleteComment(thread)">
                        Delete
                    </a-button>
                </div>
                <div v-if="replyingTo === thread.id" class="reply-compose" @click.stop>
                    <a-textarea v-model:value="replyDraft" :rows="2" :maxlength="2000" placeholder="Reply..." />
                    <a-button size="small" type="primary" :loading="submitting" @click="submitReply(thread)">
                        Reply
                    </a-button>
                </div>
            </div>
        </a-spin>
    </div>
</template>

<script setup lang="ts">
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
    import * as THREE from 'three';
    import { Box, CreateAction, MainRenderView, Object2D } from 'pc-render';
    import { Event } from 'pc-editor';
    import { useInjectEditor } from '../../state';
    import * as commentApi from '../../api/comment';
    import {
        DiscussionAnchorType,
        IDiscussionComment,
        IDiscussionPosition,
        discussionState,
        setDiscussionComments,
    } from './store';

    const editor = useInjectEditor();
    const draft = ref('');
    const replyDraft = ref('');
    const replyingTo = ref('');
    const showResolved = ref(true);
    const submitting = ref(false);
    const anchorType = ref<DiscussionAnchorType>('FRAME');
    const selectionVersion = ref(0);
    const objectAnchor = ref<{ objectId: string; trackId?: string; label: string }>();
    const positionAnchor = ref<IDiscussionPosition>();
    let pickAction: CreateAction | undefined;
    let refreshVersion = 0;

    const currentFrameId = computed(() => String(editor.getCurrentFrame()?.id || ''));
    const selectedAnnotation = computed(() => {
        selectionVersion.value;
        const object = editor.pc.selection.find(
            (item) => item instanceof Box || item instanceof Object2D,
        );
        if (!object) return undefined;
        const userData = object.userData || {};
        const classConfig = editor.getClassType(userData);
        return {
            category:
                classConfig?.label ||
                classConfig?.name ||
                userData.classType ||
                'Unclassified',
            trackId: userData.trackName || userData.trackId || '',
        };
    });
    const roots = computed(() => discussionState.comments.filter((item) => !item.parentId));
    const currentThreads = computed(() =>
        roots.value.filter((item) => String(item.dataId) === currentFrameId.value),
    );
    const visibleThreads = computed(() =>
        currentThreads.value.filter((item) => showResolved.value || !item.resolved),
    );
    const anchorSummary = computed(() => {
        if (anchorType.value === 'OBJECT') {
            return objectAnchor.value ? `Object: ${objectAnchor.value.label}` : 'Select an annotated object';
        }
        if (anchorType.value === 'POSITION') {
            const point = positionAnchor.value;
            return point
                ? `Point: ${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)}`
                : 'Pick a point in the point cloud';
        }
        return `Frame: ${currentFrameId.value || '-'}`;
    });

    watch(
        () => editor.state.frames.map((frame) => frame.id).join(','),
        (ids) => {
            if (ids) refresh();
        },
        { immediate: true },
    );

    onMounted(() => {
        editor.addEventListener(Event.DISCUSSION_OPEN, onOpenThread);
        editor.addEventListener(Event.ANNOTATE_SELECT, onAnnotationSelect);
    });

    onBeforeUnmount(() => {
        refreshVersion += 1;
        pickAction?.end();
        editor.removeEventListener(Event.DISCUSSION_OPEN, onOpenThread);
        editor.removeEventListener(Event.ANNOTATE_SELECT, onAnnotationSelect);
        setDiscussionComments([]);
    });

    async function refresh() {
        const dataIds = editor.state.frames.map((frame) => String(frame.id)).filter(Boolean);
        if (dataIds.length === 0) return;
        const requestVersion = ++refreshVersion;
        discussionState.loading = true;
        try {
            const comments = await commentApi.listComments(
                String(editor.bsState.datasetId),
                dataIds,
            );
            if (requestVersion !== refreshVersion) return;
            setDiscussionComments(comments);
            editor.state.config.commentFrameIds = Array.from(
                new Set(comments.map((comment) => String(comment.dataId))),
            );
        } catch (error) {
            editor.handleErr(error);
        } finally {
            discussionState.loading = false;
        }
    }

    async function onCommentFrameFilterChange(checked: boolean) {
        const config = editor.state.config;
        if (checked && config.commentFrameIds.length === 0) {
            editor.showMsg('warning', 'There are no commented frames in this Scene');
            config.filterFramesByComment = false;
            return;
        }
        config.filterFramesByComment = checked;
        if (checked && !config.commentFrameIds.includes(currentFrameId.value)) {
            const currentIndex = editor.state.frameIndex;
            const nearestIndex = editor.state.frames.reduce((nearest, frame, index) => {
                if (!config.commentFrameIds.includes(String(frame.id))) return nearest;
                return nearest < 0 ||
                    Math.abs(index - currentIndex) < Math.abs(nearest - currentIndex)
                    ? index
                    : nearest;
            }, -1);
            if (nearestIndex >= 0) await editor.loadFrameForNavigation(nearestIndex);
        }
    }

    function useFrame() {
        anchorType.value = 'FRAME';
        objectAnchor.value = undefined;
        positionAnchor.value = undefined;
    }

    function useSelectedObject() {
        const object = editor.pc.selection.find(
            (item) => item instanceof Box || item instanceof Object2D,
        );
        const userData = object?.userData || {};
        const objectId = String(userData.backId || userData.id || '');
        if (!object || !objectId) {
            editor.showMsg('warning', 'Please select a saved annotation object');
            return;
        }
        anchorType.value = 'OBJECT';
        objectAnchor.value = {
            objectId,
            trackId: userData.trackId,
            label: userData.trackName || userData.trackId || objectId,
        };
        positionAnchor.value = undefined;
    }

    function pickAnchor() {
        const view = editor.pc.renderViews.find(
            (item) => item instanceof MainRenderView,
        ) as MainRenderView;
        if (!view) return;
        pickAction?.end();
        pickAction = view.getAction('create-obj') as CreateAction;
        pickAction.start({ type: 'points-1', trackLine: false }, (points: THREE.Vector2[]) => {
            const object = view.getObjectByCanvas(points[0]);
            let anchoredToObject = false;
            if (object?.userData) {
                const objectId = String(object.userData.backId || object.userData.id || '');
                if (objectId) {
                    anchoredToObject = true;
                    anchorType.value = 'OBJECT';
                    objectAnchor.value = {
                        objectId,
                        trackId: object.userData.trackId,
                        label: object.userData.trackName || object.userData.trackId || objectId,
                    };
                }
            }
            if (!anchoredToObject) {
                const position = view.canvasToWorld(points[0]);
                anchorType.value = 'POSITION';
                positionAnchor.value = { x: position.x, y: position.y, z: position.z };
                objectAnchor.value = undefined;
            }
            pickAction?.end();
            pickAction = undefined;
        });
    }

    async function submitRoot() {
        const message = draft.value.trim();
        if (!message) return;
        if (anchorType.value === 'OBJECT' && !objectAnchor.value) {
            editor.showMsg('warning', 'Please select an annotation object first');
            return;
        }
        if (anchorType.value === 'POSITION' && !positionAnchor.value) {
            editor.showMsg('warning', 'Please pick a point first');
            return;
        }
        submitting.value = true;
        try {
            await commentApi.createComment({
                datasetId: String(editor.bsState.datasetId),
                dataId: currentFrameId.value,
                anchorType: anchorType.value,
                objectId: objectAnchor.value?.objectId,
                trackId: objectAnchor.value?.trackId,
                position: positionAnchor.value,
                message,
            });
            draft.value = '';
            useFrame();
            await refresh();
        } catch (error) {
            editor.handleErr(error);
        } finally {
            submitting.value = false;
        }
    }

    function repliesOf(thread: IDiscussionComment) {
        return thread.replies?.length
            ? thread.replies
            : discussionState.comments.filter(
                  (item) => String(item.parentId || item.rootId) === String(thread.id),
              );
    }

    function toggleReply(id: string) {
        replyingTo.value = replyingTo.value === id ? '' : id;
        replyDraft.value = '';
    }

    async function submitReply(thread: IDiscussionComment) {
        const message = replyDraft.value.trim();
        if (!message) return;
        submitting.value = true;
        try {
            await commentApi.createComment({
                datasetId: thread.datasetId,
                dataId: thread.dataId,
                anchorType: thread.anchorType,
                objectId: thread.objectId,
                trackId: thread.trackId,
                position: thread.position,
                parentId: thread.id,
                message,
            });
            replyingTo.value = '';
            replyDraft.value = '';
            await refresh();
        } catch (error) {
            editor.handleErr(error);
        } finally {
            submitting.value = false;
        }
    }

    async function setResolved(thread: IDiscussionComment, resolved: boolean) {
        try {
            await commentApi.setCommentResolved(thread, resolved);
            await refresh();
        } catch (error) {
            editor.handleErr(error);
        }
    }

    async function deleteComment(comment: IDiscussionComment) {
        const isThread = !comment.parentId && !comment.rootId;
        const confirmed = window.confirm(
            isThread
                ? 'Delete this comment thread and all of its replies?'
                : 'Delete this reply?',
        );
        if (!confirmed) return;
        try {
            await commentApi.deleteComment(comment);
            if (
                discussionState.activeCommentId === comment.id ||
                (isThread && discussionState.activeCommentId === String(comment.rootId || comment.id))
            ) {
                discussionState.activeCommentId = '';
            }
            if (replyingTo.value === comment.id || isThread) {
                replyingTo.value = '';
                replyDraft.value = '';
            }
            await refresh();
        } catch (error) {
            editor.handleErr(error);
        }
    }

    async function focusThread(thread: IDiscussionComment) {
        discussionState.activeCommentId = thread.id;
        if (String(thread.dataId) !== currentFrameId.value) {
            const index = editor.getFrameIndex(thread.dataId);
            if (typeof index === 'number' && index >= 0) {
                await editor.loadFrameForNavigation(index);
            }
        }
        const object = findAnchorObject(thread);
        if (object) {
            editor.cmdManager.execute('select-object', object);
            if (object instanceof Box) editor.focusObject(object);
        } else if (thread.position) {
            editor.focusPosition(
                new THREE.Vector3(thread.position.x, thread.position.y, thread.position.z),
            );
        }
    }

    function findAnchorObject(thread: IDiscussionComment) {
        if (thread.anchorType !== 'OBJECT') return undefined;
        return [...editor.pc.getAnnotate3D(), ...editor.pc.getAnnotate2D()].find((object) => {
            const userData = object.userData || {};
            return (
                (!!thread.objectId &&
                    String(userData.backId || userData.id) === String(thread.objectId)) ||
                (!!thread.trackId && userData.trackId === thread.trackId)
            );
        });
    }

    function anchorLabel(thread: IDiscussionComment) {
        if (thread.anchorType === 'OBJECT') return `Object ${thread.trackId || thread.objectId || ''}`;
        if (thread.anchorType === 'POSITION') return 'Point';
        return 'Frame';
    }

    function formatTime(value?: string) {
        return value ? new Date(value).toLocaleString() : '';
    }

    function onOpenThread(event: any) {
        const id = String(event.data?.id || '');
        const thread = roots.value.find((item) => String(item.id) === id);
        if (thread) focusThread(thread);
    }

    function onAnnotationSelect() {
        selectionVersion.value += 1;
    }
</script>

<style lang="less">
    .discussion-panel {
        height: 100%;
        color: #f0f0f0;
        overflow-y: auto;
        padding: 12px 10px;
        background: #242529;

        .discussion-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            margin-bottom: 12px;
            font-size: 16px;

            span {
                color: #8c8c8c;
                font-size: 11px;
            }
        }

        .selected-annotation {
            padding: 8px;
            margin-bottom: 10px;
            border: 1px solid #4b4b4b;
            border-left: 3px solid #69c0ff;
            border-radius: 4px;
            background: #303136;

            .selected-title {
                margin-bottom: 5px;
                color: #69c0ff;
                font-size: 11px;
                text-transform: uppercase;
            }

            > div:not(.selected-title) {
                display: flex;
                justify-content: space-between;
                gap: 8px;
                margin-top: 3px;

                span {
                    color: #a6a6a6;
                }

                strong {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
            }

            .no-selection {
                color: #a6a6a6;
                font-size: 12px;
            }
        }

        .discussion-compose {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding-bottom: 12px;
            border-bottom: 1px solid #484848;
        }

        .anchor-buttons {
            display: flex;
            gap: 4px;
            flex-wrap: wrap;
        }

        .anchor-summary,
        .thread-meta,
        .discussion-filter {
            color: #a6a6a6;
            font-size: 11px;
        }

        .discussion-filter {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 0 6px;
        }

        .comment-frame-filter {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            padding: 8px;
            margin-bottom: 8px;
            border: 1px solid #484848;
            border-radius: 4px;

            span {
                display: flex;
                flex-direction: column;
            }

            small {
                color: #8c8c8c;
                font-size: 10px;
            }
        }

        .discussion-empty {
            color: #777;
            text-align: center;
            padding: 24px 0;
        }

        .discussion-thread {
            padding: 9px;
            margin-bottom: 8px;
            border: 1px solid #4b4b4b;
            border-left: 3px solid #1890ff;
            border-radius: 4px;
            cursor: pointer;
            background: #303136;

            &.active {
                border-color: #40a9ff;
            }

            &.resolved {
                opacity: 0.65;
                border-left-color: #52c41a;
            }
        }

        .thread-meta {
            display: flex;
            justify-content: space-between;
            gap: 4px;
        }

        .anchor-kind {
            color: #69c0ff;
        }

        .thread-message {
            white-space: pre-wrap;
            margin: 6px 0;
        }

        .missing-anchor {
            color: #ff7875;
            font-size: 11px;
        }

        .discussion-reply {
            margin: 7px 0 0 12px;
            padding: 7px;
            background: #25262a;
            border-radius: 3px;
        }

        .thread-actions {
            text-align: right;
        }

        .reply-compose {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
    }
</style>
