package ai.basic.x1.adapter.port.dao;

import ai.basic.x1.adapter.port.dao.mybatis.mapper.DataAnnotationCommentMapper;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationComment;
import org.springframework.stereotype.Component;

@Component
public class DataAnnotationCommentDAO extends AbstractDAO<DataAnnotationCommentMapper, DataAnnotationComment> {
}
