package ai.basic.x1.adapter.port.dao;

import ai.basic.x1.adapter.port.dao.mybatis.mapper.SceneLocationOverrideMapper;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocationOverride;
import org.springframework.stereotype.Component;

@Component
public class SceneLocationOverrideDAO extends AbstractDAO<SceneLocationOverrideMapper, SceneLocationOverride> { }
