package ai.basic.x1.usecase;

import ai.basic.x1.adapter.exception.ApiException;
import ai.basic.x1.adapter.port.dao.DataAnnotationCommentDAO;
import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.DatasetDAO;
import ai.basic.x1.adapter.port.dao.UserDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationComment;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.Dataset;
import ai.basic.x1.adapter.port.dao.mybatis.model.User;
import ai.basic.x1.entity.DataAnnotationCommentBO;
import ai.basic.x1.entity.enums.CommentAnchorTypeEnum;
import ai.basic.x1.entity.enums.UserRoleEnum;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.util.DefaultConverter;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONObject;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.ArrayDeque;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

public class DataAnnotationCommentUseCase {

    @Autowired
    private DataAnnotationCommentDAO commentDAO;

    @Autowired
    private DataInfoDAO dataInfoDAO;

    @Autowired
    private DataAnnotationObjectDAO annotationObjectDAO;

    @Autowired
    private UserDAO userDAO;

    @Autowired
    private DatasetDAO datasetDAO;

    public List<DataAnnotationCommentBO> listByDataIds(Long datasetId, List<Long> dataIds) {
        validateDataOwnership(datasetId, dataIds);
        List<DataAnnotationComment> comments = commentDAO.list(
                Wrappers.lambdaQuery(DataAnnotationComment.class)
                        .eq(DataAnnotationComment::getDatasetId, datasetId)
                        .in(DataAnnotationComment::getDataId, dataIds)
                        .orderByAsc(DataAnnotationComment::getCreatedAt)
                        .orderByAsc(DataAnnotationComment::getId));
        List<DataAnnotationCommentBO> result =
                DefaultConverter.convert(comments, DataAnnotationCommentBO.class);
        populateAuthors(result);
        return result;
    }

    @Transactional(rollbackFor = Exception.class)
    public DataAnnotationCommentBO create(Long datasetId, Long dataId, CommentAnchorTypeEnum anchorType,
                                          Long objectId, String trackId, JSONObject position,
                                          String message, Long userId) {
        validateDataOwnership(datasetId, List.of(dataId));
        validateRootAnchor(datasetId, dataId, anchorType, objectId, trackId, position);
        OffsetDateTime now = OffsetDateTime.now();
        DataAnnotationComment comment = DataAnnotationComment.builder()
                .datasetId(datasetId)
                .dataId(dataId)
                .anchorType(anchorType)
                .objectId(anchorType == CommentAnchorTypeEnum.OBJECT ? objectId : null)
                .trackId(anchorType == CommentAnchorTypeEnum.OBJECT && StrUtil.isNotBlank(trackId)
                        ? trackId.trim() : null)
                .position(anchorType == CommentAnchorTypeEnum.POSITION ? position : null)
                .message(message.trim())
                .resolved(false)
                .createdBy(userId)
                .createdAt(now)
                .updatedAt(now)
                .build();
        commentDAO.save(comment);
        return enrich(comment);
    }

    @Transactional(rollbackFor = Exception.class)
    public DataAnnotationCommentBO reply(Long datasetId, Long dataId, Long parentId,
                                         String message, Long userId) {
        validateDataOwnership(datasetId, List.of(dataId));
        DataAnnotationComment parent = requireComment(parentId, datasetId, dataId);
        Long rootId = parent.getRootId() == null ? parent.getId() : parent.getRootId();
        DataAnnotationComment root = requireComment(rootId, datasetId, dataId);
        if (root.getParentId() != null || root.getRootId() != null) {
            throw paramError("Invalid comment thread: parentId=" + parentId + ", rootId=" + rootId);
        }
        OffsetDateTime now = OffsetDateTime.now();
        DataAnnotationComment reply = DataAnnotationComment.builder()
                .datasetId(datasetId)
                .dataId(dataId)
                .anchorType(root.getAnchorType())
                .objectId(root.getObjectId())
                .trackId(root.getTrackId())
                .position(root.getPosition())
                .message(message.trim())
                .parentId(parentId)
                .rootId(rootId)
                .resolved(false)
                .createdBy(userId)
                .createdAt(now)
                .updatedAt(now)
                .build();
        commentDAO.save(reply);
        return enrich(reply);
    }

    @Transactional(rollbackFor = Exception.class)
    public DataAnnotationCommentBO setResolved(Long commentId, Long datasetId, Long dataId,
                                               boolean resolved) {
        validateDataOwnership(datasetId, List.of(dataId));
        DataAnnotationComment root = requireComment(commentId, datasetId, dataId);
        if (root.getParentId() != null || root.getRootId() != null) {
            throw paramError("Only root comments can be resolved: commentId=" + commentId);
        }
        root.setResolved(resolved);
        commentDAO.updateById(root);
        return enrich(commentDAO.getById(commentId));
    }

    @Transactional(rollbackFor = Exception.class)
    public void delete(Long commentId, Long datasetId, Long dataId, Long userId) {
        validateDataOwnership(datasetId, List.of(dataId));
        DataAnnotationComment comment = requireComment(commentId, datasetId, dataId);
        validateDeletePermission(comment, datasetId, userId);
        if (comment.getParentId() == null && comment.getRootId() == null) {
            commentDAO.remove(Wrappers.lambdaQuery(DataAnnotationComment.class)
                    .eq(DataAnnotationComment::getDatasetId, datasetId)
                    .eq(DataAnnotationComment::getDataId, dataId)
                    .eq(DataAnnotationComment::getRootId, commentId));
            commentDAO.removeById(commentId);
            return;
        }
        commentDAO.removeByIds(collectReplySubtreeIds(comment, datasetId, dataId));
    }

    private void validateDataOwnership(Long datasetId, Collection<Long> dataIds) {
        Set<Long> requestedIds = new HashSet<>(dataIds);
        List<DataInfo> data = dataInfoDAO.list(
                Wrappers.lambdaQuery(DataInfo.class)
                        .eq(DataInfo::getDatasetId, datasetId)
                        .in(DataInfo::getId, requestedIds)
                        .eq(DataInfo::getIsDeleted, false));
        Set<Long> foundIds = data.stream().map(DataInfo::getId).collect(Collectors.toSet());
        if (!foundIds.equals(requestedIds)) {
            Set<Long> missingIds = new HashSet<>(requestedIds);
            missingIds.removeAll(foundIds);
            throw new ApiException(HttpStatus.BAD_REQUEST, UsecaseCode.PARAM_ERROR,
                    "Data does not belong to dataset or is deleted: datasetId=" + datasetId
                            + ", dataIds=" + missingIds);
        }
    }

    private void validateRootAnchor(Long datasetId, Long dataId, CommentAnchorTypeEnum anchorType,
                                    Long objectId, String trackId, JSONObject position) {
        if (anchorType == CommentAnchorTypeEnum.POSITION && position == null) {
            throw paramError("position is required for POSITION anchor: datasetId=" + datasetId
                    + ", dataId=" + dataId);
        }
        if (anchorType != CommentAnchorTypeEnum.OBJECT) {
            return;
        }
        if (objectId == null && StrUtil.isBlank(trackId)) {
            throw paramError("objectId or trackId is required for OBJECT anchor: datasetId="
                    + datasetId + ", dataId=" + dataId);
        }
        if (objectId != null) {
            DataAnnotationObject object = annotationObjectDAO.getById(objectId);
            if (object == null || !datasetId.equals(object.getDatasetId())
                    || !dataId.equals(object.getDataId())) {
                throw paramError("Annotation object does not belong to data: datasetId=" + datasetId
                        + ", dataId=" + dataId + ", objectId=" + objectId);
            }
            if (StrUtil.isNotBlank(trackId) && (object.getClassAttributes() == null
                    || !trackId.equals(object.getClassAttributes().getStr("trackId")))) {
                throw paramError("trackId does not match annotation object: objectId=" + objectId
                        + ", trackId=" + trackId);
            }
            return;
        }
        boolean trackExists = annotationObjectDAO.list(
                        Wrappers.lambdaQuery(DataAnnotationObject.class)
                                .eq(DataAnnotationObject::getDatasetId, datasetId)
                                .eq(DataAnnotationObject::getDataId, dataId))
                .stream()
                .anyMatch(object -> object.getClassAttributes() != null
                        && trackId.equals(object.getClassAttributes().getStr("trackId")));
        if (!trackExists) {
            throw paramError("trackId does not belong to data: datasetId=" + datasetId
                    + ", dataId=" + dataId + ", trackId=" + trackId);
        }
    }

    private DataAnnotationComment requireComment(Long commentId, Long datasetId, Long dataId) {
        DataAnnotationComment comment = commentDAO.getById(commentId);
        if (comment == null || !datasetId.equals(comment.getDatasetId())
                || !dataId.equals(comment.getDataId())) {
            throw new ApiException(HttpStatus.NOT_FOUND, UsecaseCode.NOT_FOUND,
                    "Comment not found in data: commentId=" + commentId + ", datasetId="
                            + datasetId + ", dataId=" + dataId);
        }
        return comment;
    }

    private void validateDeletePermission(DataAnnotationComment comment, Long datasetId, Long userId) {
        if (userId.equals(comment.getCreatedBy())) {
            return;
        }
        User user = userDAO.getById(userId);
        if (user != null && UserRoleEnum.ADMIN.equals(user.getRole())) {
            return;
        }
        Dataset dataset = datasetDAO.getById(datasetId);
        if (dataset != null && userId.equals(dataset.getCreatedBy())) {
            return;
        }
        throw new ApiException(HttpStatus.FORBIDDEN, UsecaseCode.PARAM_ERROR,
                "Only the comment author or a dataset administrator can delete this comment");
    }

    private Set<Long> collectReplySubtreeIds(DataAnnotationComment reply, Long datasetId, Long dataId) {
        Set<Long> result = new HashSet<>();
        ArrayDeque<Long> pending = new ArrayDeque<>();
        pending.add(reply.getId());
        while (!pending.isEmpty()) {
            Long parentId = pending.removeFirst();
            if (!result.add(parentId)) {
                continue;
            }
            commentDAO.list(Wrappers.lambdaQuery(DataAnnotationComment.class)
                            .eq(DataAnnotationComment::getDatasetId, datasetId)
                            .eq(DataAnnotationComment::getDataId, dataId)
                            .eq(DataAnnotationComment::getParentId, parentId))
                    .forEach(child -> pending.addLast(child.getId()));
        }
        return result;
    }

    private DataAnnotationCommentBO enrich(DataAnnotationComment comment) {
        DataAnnotationCommentBO result =
                DefaultConverter.convert(comment, DataAnnotationCommentBO.class);
        populateAuthors(List.of(result));
        return result;
    }

    private void populateAuthors(List<DataAnnotationCommentBO> comments) {
        Set<Long> userIds = comments.stream()
                .map(DataAnnotationCommentBO::getCreatedBy)
                .collect(Collectors.toSet());
        if (userIds.isEmpty()) {
            return;
        }
        Map<Long, User> users = userDAO.listByIds(userIds).stream()
                .collect(Collectors.toMap(User::getId, user -> user));
        comments.forEach(comment -> {
            User user = users.get(comment.getCreatedBy());
            if (user != null) {
                comment.setAuthorUsername(user.getUsername());
                comment.setAuthorNickname(user.getNickname());
                comment.setAuthorAvatarId(user.getAvatarId());
            }
        });
    }

    private ApiException paramError(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, UsecaseCode.PARAM_ERROR, message);
    }
}
