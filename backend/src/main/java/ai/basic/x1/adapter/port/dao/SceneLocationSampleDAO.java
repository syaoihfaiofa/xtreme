package ai.basic.x1.adapter.port.dao;

import ai.basic.x1.adapter.port.dao.mybatis.mapper.SceneLocationSampleMapper;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocationSample;
import org.springframework.stereotype.Component;

@Component
public class SceneLocationSampleDAO extends AbstractDAO<SceneLocationSampleMapper, SceneLocationSample> {
}
