package ai.basic.x1.adapter.port.dao;

import ai.basic.x1.adapter.port.dao.mybatis.mapper.SceneInferenceRunMapper;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneInferenceRun;
import org.springframework.stereotype.Component;

@Component
public class SceneInferenceRunDAO extends AbstractDAO<SceneInferenceRunMapper, SceneInferenceRun> {
}
