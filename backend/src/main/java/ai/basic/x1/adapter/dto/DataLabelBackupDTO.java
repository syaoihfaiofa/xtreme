package ai.basic.x1.adapter.dto;

import lombok.Data;

import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;
import java.util.List;

/** Request to write ground-truth labels to a server-side backup directory. */
@Data
public class DataLabelBackupDTO {

    @NotNull(message = "datasetId cannot be null")
    private Long datasetId;

    /** Empty means every item in the dataset. */
    private List<Long> ids;

    /** Directory relative to file.backupPath. */
    @NotBlank(message = "destinationDirectory cannot be blank")
    private String destinationDirectory;
}
