package ai.basic.x1.adapter.port.dao;

import ai.basic.x1.adapter.port.dao.mybatis.mapper.ReconstructionAnnotationMapper;
import ai.basic.x1.adapter.port.dao.mybatis.model.ReconstructionAnnotation;
import org.springframework.stereotype.Component;

@Component
public class ReconstructionAnnotationDAO extends AbstractDAO<ReconstructionAnnotationMapper, ReconstructionAnnotation> {
}
