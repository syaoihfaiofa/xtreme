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
import ai.basic.x1.adapter.port.dao.mybatis.model.User;
import ai.basic.x1.entity.DataAnnotationCommentBO;
import ai.basic.x1.entity.enums.CommentAnchorTypeEnum;
import ai.basic.x1.entity.enums.UserRoleEnum;
import cn.hutool.json.JSONUtil;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class DataAnnotationCommentUseCaseTest {

    private static final Long DATASET_ID = 1L;
    private static final Long DATA_ID = 10L;

    @Mock
    private DataAnnotationCommentDAO commentDAO;

    @Mock
    private DataInfoDAO dataInfoDAO;

    @Mock
    private DataAnnotationObjectDAO annotationObjectDAO;

    @Mock
    private UserDAO userDAO;

    @Mock
    private DatasetDAO datasetDAO;

    @InjectMocks
    private DataAnnotationCommentUseCase useCase;

    @BeforeEach
    void setUp() {
        when(dataInfoDAO.list(any())).thenReturn(List.of(
                DataInfo.builder()
                        .id(DATA_ID)
                        .datasetId(DATASET_ID)
                        .isDeleted(false)
                        .build()));
    }

    @Test
    void test_create_rejects_position_anchor_without_position() {
        ApiException exception = assertThrows(ApiException.class, () -> useCase.create(
                DATASET_ID, DATA_ID, CommentAnchorTypeEnum.POSITION,
                null, null, null, "message", 100L));

        assertEquals("position is required for POSITION anchor: datasetId=1, dataId=10",
                exception.getMessage());
    }

    @Test
    void test_create_rejects_object_from_different_dataset() {
        when(annotationObjectDAO.getById(50L)).thenReturn(
                DataAnnotationObject.builder()
                        .id(50L)
                        .datasetId(2L)
                        .dataId(DATA_ID)
                        .build());

        ApiException exception = assertThrows(ApiException.class, () -> useCase.create(
                DATASET_ID, DATA_ID, CommentAnchorTypeEnum.OBJECT,
                50L, "track-1", null, "message", 100L));

        assertEquals("Annotation object does not belong to data: datasetId=1, dataId=10, objectId=50",
                exception.getMessage());
    }

    @Test
    void test_reply_inherits_root_anchor_and_thread_id() {
        DataAnnotationComment root = DataAnnotationComment.builder()
                .id(20L)
                .datasetId(DATASET_ID)
                .dataId(DATA_ID)
                .anchorType(CommentAnchorTypeEnum.POSITION)
                .position(JSONUtil.parseObj("{\"x\":1,\"y\":2,\"z\":3}"))
                .message("root")
                .resolved(false)
                .createdBy(100L)
                .build();
        when(commentDAO.getById(20L)).thenReturn(root);
        when(commentDAO.save(any())).thenAnswer(invocation -> {
            DataAnnotationComment reply = invocation.getArgument(0);
            reply.setId(21L);
            return true;
        });
        when(userDAO.listByIds(anyCollection())).thenReturn(List.of());

        DataAnnotationCommentBO result = useCase.reply(
                DATASET_ID, DATA_ID, 20L, "reply", 101L);

        ArgumentCaptor<DataAnnotationComment> captor =
                ArgumentCaptor.forClass(DataAnnotationComment.class);
        verify(commentDAO).save(captor.capture());
        DataAnnotationComment saved = captor.getValue();
        assertEquals(20L, saved.getParentId());
        assertEquals(20L, saved.getRootId());
        assertEquals(CommentAnchorTypeEnum.POSITION, saved.getAnchorType());
        assertEquals(root.getPosition(), saved.getPosition());
        assertEquals(21L, result.getId());
        assertEquals(20L, result.getRootId());
    }

    @Test
    void test_resolve_rejects_reply_comment() {
        when(commentDAO.getById(21L)).thenReturn(
                DataAnnotationComment.builder()
                        .id(21L)
                        .datasetId(DATASET_ID)
                        .dataId(DATA_ID)
                        .parentId(20L)
                        .rootId(20L)
                        .build());

        ApiException exception = assertThrows(ApiException.class,
                () -> useCase.setResolved(21L, DATASET_ID, DATA_ID, true));

        assertEquals("Only root comments can be resolved: commentId=21", exception.getMessage());
    }

    @Test
    void test_delete_root_by_author_removes_replies_and_root() {
        DataAnnotationComment root = DataAnnotationComment.builder()
                .id(20L)
                .datasetId(DATASET_ID)
                .dataId(DATA_ID)
                .createdBy(100L)
                .build();
        when(commentDAO.getById(20L)).thenReturn(root);

        useCase.delete(20L, DATASET_ID, DATA_ID, 100L);

        verify(commentDAO).remove(any());
        verify(commentDAO).removeById(20L);
    }

    @Test
    void test_delete_reply_by_author_only_removes_reply() {
        DataAnnotationComment reply = DataAnnotationComment.builder()
                .id(21L)
                .datasetId(DATASET_ID)
                .dataId(DATA_ID)
                .parentId(20L)
                .rootId(20L)
                .createdBy(101L)
                .build();
        when(commentDAO.getById(21L)).thenReturn(reply);
        when(commentDAO.list(any())).thenReturn(List.of());

        useCase.delete(21L, DATASET_ID, DATA_ID, 101L);

        verify(commentDAO, never()).remove(any());
        verify(commentDAO).removeByIds(anyCollection());
    }

    @Test
    void test_delete_allows_admin() {
        DataAnnotationComment comment = DataAnnotationComment.builder()
                .id(20L)
                .datasetId(DATASET_ID)
                .dataId(DATA_ID)
                .createdBy(100L)
                .build();
        when(commentDAO.getById(20L)).thenReturn(comment);
        when(userDAO.getById(200L)).thenReturn(User.builder().id(200L).role(UserRoleEnum.ADMIN).build());

        useCase.delete(20L, DATASET_ID, DATA_ID, 200L);

        verify(commentDAO).removeById(20L);
    }

    @Test
    void test_delete_rejects_non_author_non_admin() {
        DataAnnotationComment comment = DataAnnotationComment.builder()
                .id(20L)
                .datasetId(DATASET_ID)
                .dataId(DATA_ID)
                .createdBy(100L)
                .build();
        when(commentDAO.getById(20L)).thenReturn(comment);
        when(userDAO.getById(200L)).thenReturn(User.builder().id(200L).role(UserRoleEnum.REVIEWER).build());

        assertThrows(ApiException.class, () -> useCase.delete(20L, DATASET_ID, DATA_ID, 200L));

        verify(commentDAO, never()).removeById(20L);
    }
}
