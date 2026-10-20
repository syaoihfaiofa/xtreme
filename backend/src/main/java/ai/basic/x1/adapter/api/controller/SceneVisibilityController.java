package ai.basic.x1.adapter.api.controller;

import ai.basic.x1.adapter.dto.SceneVisibilityRunDTO;
import ai.basic.x1.adapter.api.annotation.user.LoggedUser;
import ai.basic.x1.adapter.dto.LoggedUserDTO;
import ai.basic.x1.adapter.dto.request.SceneVisibilityEnsureRequestDTO;
import ai.basic.x1.adapter.dto.request.SceneVisibilityProgressRequestDTO;
import ai.basic.x1.adapter.dto.request.SceneVisibilityTaskRequestDTO;
import ai.basic.x1.usecase.SceneVisibilityUseCase;
import ai.basic.x1.usecase.exception.UsecaseException;
import ai.basic.x1.util.DefaultConverter;
import cn.hutool.json.JSONObject;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;

@RestController
@RequestMapping("/annotate/visibility")
public class SceneVisibilityController {

    @Autowired
    private SceneVisibilityUseCase sceneVisibilityUseCase;

    @Value("${visibility.progress.shared-secret}")
    private String progressSharedSecret;

    @PostMapping("/ensure")
    public SceneVisibilityRunDTO ensure(
            @Validated @RequestBody SceneVisibilityEnsureRequestDTO request,
            @LoggedUser LoggedUserDTO user) {
        return DefaultConverter.convert(
                sceneVisibilityUseCase.ensure(
                        request.getDatasetId(), request.getSceneId(), request.getSelectedDataIds(), user.getId()),
                SceneVisibilityRunDTO.class);
    }

    @PostMapping("/force")
    public SceneVisibilityRunDTO force(
            @Validated @RequestBody SceneVisibilityEnsureRequestDTO request,
            @LoggedUser LoggedUserDTO user) {
        return DefaultConverter.convert(
                sceneVisibilityUseCase.force(
                        request.getDatasetId(), request.getSceneId(), request.getSelectedDataIds(), user.getId()),
                SceneVisibilityRunDTO.class);
    }

    @PostMapping("/tasks/visibility")
    public SceneVisibilityRunDTO ensureVisibility(
            @Validated @RequestBody SceneVisibilityTaskRequestDTO request,
            @LoggedUser LoggedUserDTO user) {
        return DefaultConverter.convert(
                sceneVisibilityUseCase.ensureVisibility(
                        request.getOccRunId(), request.getSelectedDataIds(), user.getId()),
                SceneVisibilityRunDTO.class);
    }

    @GetMapping("/status/{id}")
    public SceneVisibilityRunDTO status(@PathVariable Long id, @LoggedUser LoggedUserDTO user) {
        return DefaultConverter.convert(
                sceneVisibilityUseCase.status(id, user.getId()),
                SceneVisibilityRunDTO.class);
    }

    @GetMapping("/runs")
    public List<SceneVisibilityRunDTO> runs(
            @RequestParam Long datasetId,
            @RequestParam Long sceneId,
            @LoggedUser LoggedUserDTO user) {
        return DefaultConverter.convert(
                sceneVisibilityUseCase.listRuns(datasetId, sceneId, user.getId()),
                SceneVisibilityRunDTO.class);
    }

    @PostMapping("/runs/{id}/cancel")
    public SceneVisibilityRunDTO cancel(
            @PathVariable Long id, @LoggedUser LoggedUserDTO user) {
        return DefaultConverter.convert(
                sceneVisibilityUseCase.cancel(id, user.getId()),
                SceneVisibilityRunDTO.class);
    }

    @org.springframework.web.bind.annotation.DeleteMapping("/runs/{id}")
    public void deleteOccRun(
            @PathVariable Long id, @LoggedUser LoggedUserDTO user) {
        sceneVisibilityUseCase.deleteOccRun(id, user.getId());
    }

    @GetMapping("/{occRunId}/latest-task")
    public SceneVisibilityRunDTO latestVisibilityTask(
            @PathVariable Long occRunId,
            @LoggedUser LoggedUserDTO user) {
        return DefaultConverter.convert(
                sceneVisibilityUseCase.latestVisibilityTask(occRunId, user.getId()),
                SceneVisibilityRunDTO.class);
    }

    @GetMapping("/scene/{sceneId}/frames")
    public List<Long> sceneFrameIds(
            @PathVariable Long sceneId,
            @RequestParam Long datasetId,
            @LoggedUser LoggedUserDTO user) {
        return sceneVisibilityUseCase.sceneFrameIds(datasetId, sceneId, user.getId());
    }

    @PostMapping("/internal/runs/{id}/progress")
    public void progress(
            @PathVariable Long id,
            @RequestHeader("X-Xtreme-Occ-Progress-Secret") String providedSecret,
            @Validated @RequestBody SceneVisibilityProgressRequestDTO request) {
        if (!MessageDigest.isEqual(
                progressSharedSecret.getBytes(StandardCharsets.UTF_8),
                providedSecret.getBytes(StandardCharsets.UTF_8))) {
            throw new UsecaseException("Visibility progress authentication failed");
        }
        sceneVisibilityUseCase.updateProgress(id, request.getStage(), request.getCompletedFrames());
    }

    @GetMapping("/{runId}/frame/{dataId}")
    public JSONObject frameResult(
            @PathVariable Long runId,
            @PathVariable Long dataId,
            @LoggedUser LoggedUserDTO user) {
        return sceneVisibilityUseCase.frameResult(runId, dataId, user.getId());
    }

    @GetMapping("/{runId}/frame/{dataId}/occ")
    public JSONObject occVisualization(
            @PathVariable Long runId,
            @PathVariable Long dataId,
            @RequestParam(required = false) Integer maxVoxels,
            @RequestParam(defaultValue = "semantic") String layer,
            @LoggedUser LoggedUserDTO user) {
        return sceneVisibilityUseCase.occVisualization(runId, dataId, maxVoxels, layer, user.getId());
    }
}
