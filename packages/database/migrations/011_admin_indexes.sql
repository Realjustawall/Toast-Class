CREATE INDEX audit_logs_org_time ON audit_logs(organization_id,created_at DESC,id DESC);
CREATE INDEX audit_logs_org_action_time ON audit_logs(organization_id,action,created_at DESC,id DESC);
