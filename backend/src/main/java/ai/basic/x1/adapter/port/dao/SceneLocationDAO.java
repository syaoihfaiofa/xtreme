package ai.basic.x1.adapter.port.dao;

import ai.basic.x1.adapter.port.dao.mybatis.mapper.SceneLocationMapper;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocation;
import org.springframework.stereotype.Component;

/**
 * @author fyb
 */
@Component
public class SceneLocationDAO extends AbstractDAO<SceneLocationMapper, SceneLocation> {
}
