package ai.basic.x1.adapter.api.controller;

import ai.basic.x1.adapter.dto.SceneInferenceRunDTO;
import ai.basic.x1.adapter.dto.request.SceneInferenceEnsureRequestDTO;
import ai.basic.x1.usecase.SceneInferenceUseCase;
import ai.basic.x1.util.DefaultConverter;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/annotate/inference")
public class SceneInferenceController {

    @Autowired
    private SceneInferenceUseCase sceneInferenceUseCase;

    @PostMapping("/ensure")
    public SceneInferenceRunDTO ensure(@Validated @RequestBody SceneInferenceEnsureRequestDTO request) {
        return DefaultConverter.convert(sceneInferenceUseCase.ensure(request.getRecordId()), SceneInferenceRunDTO.class);
    }

    @GetMapping("/status/{runId}")
    public SceneInferenceRunDTO status(@PathVariable Long runId) {
        return DefaultConverter.convert(sceneInferenceUseCase.status(runId), SceneInferenceRunDTO.class);
    }
}
