ALTER TABLE presentation_assets ADD CONSTRAINT presentation_asset_dimensions CHECK(
 (page_number=0 AND width IS NULL AND height IS NULL) OR
 (page_number>0 AND width IS NOT NULL AND height IS NOT NULL AND width BETWEEN 1 AND 1600 AND height BETWEEN 1 AND 1600)
);
ALTER TABLE presentations ADD CONSTRAINT presentation_processing_claim CHECK(
 (status='processing' AND claim IS NOT NULL AND claimed_until IS NOT NULL) OR
 (status<>'processing' AND claim IS NULL AND claimed_until IS NULL)
);
ALTER TABLE presentations ADD CONSTRAINT presentation_ready_pages CHECK(status NOT IN ('scanning','ready') OR page_count IS NOT NULL);
ALTER TABLE presentations ADD CONSTRAINT presentation_queue_reservation CHECK(status<>'queued' OR reserved_bytes>0);
