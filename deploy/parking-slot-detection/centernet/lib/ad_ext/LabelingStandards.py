

kCornerClassPrefix = 'corner_'
kPartialClassSuffix = '_partial'

kMODClassesInStandards = {
    # mod classes
    'v0': ["car", "person", "bike", 
                "pillar", "cone", 
                "parkinglock_locked", 
                "board_no_parking", "ev_charger"],
    'v1': ["car", "bus", "truck", "tricycle", 
                "bike", "person", "pillar", "cone", 
                "parkinglock_locked", "parkinglock_unlocked", 
                "board_no_parking", "ev_charger", "boom_gate", 
                "pole", "barrier", "handcart"],
    'v1a': ["car", "bus", "truck", "tricycle", 
                "bike", "person", "pillar", "cone", 
                "parkinglock_locked", "parkinglock_unlocked", 
                "board_no_parking", "ev_charger", "boom_gate", 
                "pole", "barrier", "handcart", 
                "wheel_stopper", "curb", "wall"],
    'v1d': ["car", "bus", "truck", "tricycle", 
                "bike", "person", "pillar", "cone", 
                "parkinglock_locked", "parkinglock_unlocked", 
                "board_no_parking", "ev_charger", "boom_gate", 
                "pole", "barrier", "handcart", 
                "wheel_stopper", "curb", "wall",
                "fence", "box_cardboard", "box_trash"],
    'v1e': ["car", "bus", "truck", "tricycle", 
                "bike", "person", "pillar", "cone", 
                "parkinglock_locked", "parkinglock_unlocked", 
                "board_no_parking", "ev_charger", "boom_gate", 
                "pole", "barrier", "handcart", 
                "wheel_stopper", "curb", "wall",
                "fence", "box_cardboard", "box_trash",
                "barrel_barrier", "concrete_ball", "post"],
    
    # add freespace to previous labeled images 
    'v0f': ["car", "person", "bike", 
                "pillar", "cone", 
                "parkinglock_locked", 
                "board_no_parking", "ev_charger",
                "freespace"],
    'v1f': ["car", "bus", "truck", "tricycle", 
                "bike", "person", "pillar", "cone", 
                "parkinglock_locked", "parkinglock_unlocked", 
                "board_no_parking", "ev_charger", "boom_gate", 
                "pole", "barrier", "handcart",
                "freespace"],
    'v1af': ["car", "bus", "truck", "tricycle", 
                "bike", "person", "pillar", "cone", 
                "parkinglock_locked", "parkinglock_unlocked", 
                "board_no_parking", "ev_charger", "boom_gate", 
                "pole", "barrier", "handcart", 
                "wheel_stopper", "curb", "wall",
                "freespace"],
    'v1df': ["car", "bus", "truck", "tricycle", 
                "bike", "person", "pillar", "cone", 
                "parkinglock_locked", "parkinglock_unlocked", 
                "board_no_parking", "ev_charger", "boom_gate", 
                "pole", "barrier", "handcart", 
                "wheel_stopper", "curb", "wall",
                "fence", "box_cardboard", "box_trash",
                "freespace"],
    'v1ef': ["car", "bus", "truck", "tricycle", 
                "bike", "person", "pillar", "cone", 
                "parkinglock_locked", "parkinglock_unlocked", 
                "board_no_parking", "ev_charger", "boom_gate", 
                "pole", "barrier", "handcart", 
                "wheel_stopper", "curb", "wall",
                "fence", "box_cardboard", "box_trash",
                "barrel_barrier", "concrete_ball", "post",
                "freespace"],

    # topdown classes labeled on topdown images
    'v2a': ["wheel_stopper", "parkinglock_locked"],
    'v2b': ["car", "wheel_stopper", "parkinglock_locked"],
    'v2c': ["car", "pillar", "wheel_stopper", "parkinglock_locked"],
    'v2d': ["car", "pillar", "parkinglock_locked"],
    
    # add freespace to previous labeled images 
    'v2af': ["wheel_stopper", "parkinglock_locked", "freespace"],
    'v2bf': ["car", "wheel_stopper", "parkinglock_locked", "freespace"],
    'v2cf': ["car", "pillar", "wheel_stopper", "parkinglock_locked", "freespace"],
    'v2df': ["car", "pillar", "parkinglock_locked", "freespace"],

    

    # segmentation
    'v4a': ["freespace"],
    'v4b': ["freespace", "obstacle"],
}


kPSDClassesInStandards = {
    'v0': ["parkinglot", "parkinglot_parked", "parkinglot_mechanical", "parkinglot_handicap"],
    'v1': ["parkinglot", "parkinglot_parked", "parkinglot_mechanical", "parkinglot_handicap"],
    'v2a': ["parkinglot", "parkinglot_parked", "parkinglot_mechanical", "parkinglot_handicap",
         "parkinglot_partial", "parkinglot_parked_partial", 
         "parkinglot_mechanical_partial", "parkinglot_handicap_partial"],
}
