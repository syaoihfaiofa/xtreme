package ai.basic.x1.adapter.api.controller;

import ai.basic.x1.adapter.api.annotation.user.LoggedUser;
import ai.basic.x1.adapter.dto.LoggedUserDTO;
import ai.basic.x1.adapter.dto.request.DataAnnotationCommentCreateDTO;
import ai.basic.x1.adapter.dto.request.DataAnnotationCommentReplyDTO;
import ai.basic.x1.adapter.dto.response.DataAnnotationCommentResponseDTO;
import ai.basic.x1.entity.DataAnnotationCommentBO;
import ai.basic.x1.entity.enums.CommentAnchorTypeEnum;
import ai.basic.x1.usecase.DataAnnotationCommentUseCase;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import javax.validation.constraints.NotEmpty;
import javax.validation.constraints.NotNull;
import java.util.List;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/annotate/comment/")
@Validated
public class DataAnnotationCommentController {

    @Autowired
    private DataAnnotationCommentUseCase commentUseCase;

    @GetMapping("listByDataIds")
    public List<DataAnnotationCommentResponseDTO> listByDataIds(
            @NotNull(message = "datasetId cannot be null") @RequestParam Long datasetId,
            @NotEmpty(message = "dataIds cannot be empty") @RequestParam List<Long> dataIds) {
        return commentUseCase.listByDataIds(datasetId, dataIds).stream()
                .map(this::toResponse)
                .collect(Collectors.toList());
    }

    @PostMapping("create")
    public DataAnnotationCommentResponseDTO create(
            @Validated @RequestBody DataAnnotationCommentCreateDTO request,
            @LoggedUser LoggedUserDTO user) {
        DataAnnotationCommentBO comment = commentUseCase.create(
                request.getDatasetId(),
                request.getDataId(),
                CommentAnchorTypeEnum.valueOf(request.getAnchorType()),
                request.getObjectId(),
                request.getTrackId(),
                request.getPosition(),
                request.getMessage(),
                user.getId());
        return toResponse(comment);
    }

    @PostMapping("reply")
    public DataAnnotationCommentResponseDTO reply(
            @Validated @RequestBody DataAnnotationCommentReplyDTO request,
            @LoggedUser LoggedUserDTO user) {
        return toResponse(commentUseCase.reply(
                request.getDatasetId(),
                request.getDataId(),
                request.getParentId(),
                request.getMessage(),
                user.getId()));
    }

    @PostMapping("{id}/resolve")
    public DataAnnotationCommentResponseDTO resolve(
            @PathVariable Long id,
            @NotNull(message = "datasetId cannot be null") @RequestParam Long datasetId,
            @NotNull(message = "dataId cannot be null") @RequestParam Long dataId) {
        return toResponse(commentUseCase.setResolved(id, datasetId, dataId, true));
    }

    @PostMapping("{id}/reopen")
    public DataAnnotationCommentResponseDTO reopen(
            @PathVariable Long id,
            @NotNull(message = "datasetId cannot be null") @RequestParam Long datasetId,
            @NotNull(message = "dataId cannot be null") @RequestParam Long dataId) {
        return toResponse(commentUseCase.setResolved(id, datasetId, dataId, false));
    }

    @PostMapping("{id}/delete")
    public void delete(
            @PathVariable Long id,
            @NotNull(message = "datasetId cannot be null") @RequestParam Long datasetId,
            @NotNull(message = "dataId cannot be null") @RequestParam Long dataId,
            @LoggedUser LoggedUserDTO user) {
        commentUseCase.delete(id, datasetId, dataId, user.getId());
    }

    private DataAnnotationCommentResponseDTO toResponse(DataAnnotationCommentBO comment) {
        return DataAnnotationCommentResponseDTO.builder()
                .id(comment.getId())
                .datasetId(comment.getDatasetId())
                .dataId(comment.getDataId())
                .anchorType(comment.getAnchorType())
                .objectId(comment.getObjectId())
                .trackId(comment.getTrackId())
                .position(comment.getPosition())
                .message(comment.getMessage())
                .parentId(comment.getParentId())
                .rootId(comment.getRootId() == null ? comment.getId() : comment.getRootId())
                .resolved(comment.getResolved())
                .author(DataAnnotationCommentResponseDTO.AuthorDTO.builder()
                        .id(comment.getCreatedBy())
                        .username(comment.getAuthorUsername())
                        .nickname(comment.getAuthorNickname())
                        .avatarId(comment.getAuthorAvatarId())
                        .build())
                .createdAt(comment.getCreatedAt())
                .updatedAt(comment.getUpdatedAt())
                .build();
    }
}
