package ai.basic.x1.adapter.port.dao;

import ai.basic.x1.adapter.port.dao.mybatis.mapper.DatasetLabelSnapshotMapper;
import ai.basic.x1.adapter.port.dao.mybatis.model.DatasetLabelSnapshot;
import org.springframework.stereotype.Component;

@Component
public class DatasetLabelSnapshotDAO
        extends AbstractDAO<DatasetLabelSnapshotMapper, DatasetLabelSnapshot> {
}
