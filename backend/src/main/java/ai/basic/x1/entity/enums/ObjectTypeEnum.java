package ai.basic.x1.entity.enums;

public enum ObjectTypeEnum {
    THREE_D_BOX("3D_BOX"),
    TWO_D_BOX("2D_BOX"),

    TWO_RECT("2D_RECT"),
    BOUNDING_BOX("BOUNDING_BOX"),

    POLYLINE("POLYLINE"),

    POLYGON("POLYGON"),
    GROUND_POLYGON("GROUND_POLYGON"),
    TWO_D_GROUND_POLYGON("2D_GROUND_POLYGON"),
    GROUND_POLYLINE("GROUND_POLYLINE"),
    TWO_D_GROUND_POLYLINE("2D_GROUND_POLYLINE"),
    IRREGULAR_WALL("IRREGULAR_WALL"),
    TWO_D_IRREGULAR_WALL("2D_IRREGULAR_WALL"),
    THREE_D_SEGMENT_POINTS("3D_SEGMENT_POINTS");

    private String value;

    ObjectTypeEnum(String value) {
        this.value = value;
    }

    public String getValue() {
        return value;
    }

    public void setValue(String value) {
        this.value = value;
    }

    @Override
    public String toString() {
        return this.value;
    }
}
