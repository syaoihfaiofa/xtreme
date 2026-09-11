package ai.basic.x1.adapter.port.dao;

import ai.basic.x1.adapter.port.dao.mybatis.mapper.ReconstructionSceneMapper;
import ai.basic.x1.adapter.port.dao.mybatis.model.ReconstructionScene;
import org.springframework.stereotype.Component;

@Component
public class ReconstructionSceneDAO extends AbstractDAO<ReconstructionSceneMapper, ReconstructionScene> {
}
