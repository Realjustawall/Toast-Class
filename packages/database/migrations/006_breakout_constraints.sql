ALTER TABLE breakout_rooms ADD CONSTRAINT breakout_room_group_pair UNIQUE(group_id,classroom_id);
ALTER TABLE breakout_assignments ADD CONSTRAINT breakout_assignment_group_room
 FOREIGN KEY(group_id,room_id) REFERENCES breakout_rooms(group_id,classroom_id);
ALTER TABLE breakout_assignment_events ADD CONSTRAINT breakout_event_group_room
 FOREIGN KEY(group_id,room_id) REFERENCES breakout_rooms(group_id,classroom_id);
