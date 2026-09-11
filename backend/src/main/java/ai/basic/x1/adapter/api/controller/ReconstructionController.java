package ai.basic.x1.adapter.api.controller;

import ai.basic.x1.adapter.api.annotation.user.LoggedUser;
import ai.basic.x1.adapter.dto.ReconstructionAnnotationDTO;
import ai.basic.x1.adapter.dto.ReconstructionSceneDTO;
import ai.basic.x1.adapter.dto.LoggedUserDTO;
import ai.basic.x1.adapter.dto.request.ReconstructionUploadDTO;
import ai.basic.x1.usecase.ReconstructionUseCase;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.multipart.MultipartFile;

import javax.validation.Valid;
import javax.validation.constraints.NotNull;
import java.util.List;

/** Completely separate from /data and /annotate/data legacy APIs. */
@RestController
@RequestMapping("/reconstruction")
@Validated
public class ReconstructionController extends BaseController {
    @Autowired private ReconstructionUseCase reconstructionUseCase;

    @PostMapping("/upload")
    public List<Long> upload(@RequestBody @Valid ReconstructionUploadDTO dto, @LoggedUser LoggedUserDTO user) {
        return reconstructionUseCase.upload(dto.getDatasetId(), dto.getFileUrl(), user.getId());
    }

    @PostMapping(value = "/upload/file", consumes = "multipart/form-data")
    public List<Long> uploadFile(@RequestParam @NotNull Long datasetId, @RequestPart("file") MultipartFile file,
                                 @LoggedUser LoggedUserDTO user) {
        return reconstructionUseCase.uploadFile(datasetId, file, user.getId());
    }

    @GetMapping("/scenes")
    public List<ReconstructionSceneDTO> listScenes(@RequestParam @NotNull Long datasetId) {
        return reconstructionUseCase.listScenes(datasetId);
    }

    @GetMapping("/scenes/{sceneId}")
    public ReconstructionSceneDTO getScene(@PathVariable Long sceneId) {
        return reconstructionUseCase.getScene(sceneId);
    }

    @GetMapping("/scenes/{sceneId}/annotations")
    public List<ReconstructionAnnotationDTO> listAnnotations(@PathVariable Long sceneId) {
        return reconstructionUseCase.listAnnotations(sceneId);
    }

    @PostMapping("/scenes/{sceneId}/annotations")
    public List<ReconstructionAnnotationDTO> saveAnnotations(@PathVariable Long sceneId,
            @RequestBody List<@Valid ReconstructionAnnotationDTO> annotations, @LoggedUser LoggedUserDTO user) {
        return reconstructionUseCase.saveAnnotations(sceneId, annotations, user.getId());
    }

    @DeleteMapping("/scenes/{sceneId}/annotations/{annotationId}")
    public void deleteAnnotation(@PathVariable Long sceneId, @PathVariable Long annotationId) {
        reconstructionUseCase.deleteAnnotation(sceneId, annotationId);
    }
}
