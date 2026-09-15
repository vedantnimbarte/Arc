-- ProxyJump and saved port forwards on SSH hosts.
--
-- jump_host_id names another saved host to connect through. Deleting that
-- host clears the link, so the dependent host falls back to a direct connect
-- rather than becoming unconnectable.
--
-- forwards_json is a JSON array of arc_ssh::ForwardSpec
-- ({kind, bind_port, dest_host, dest_port}), validated by the command layer
-- before it is written. Existing rows get no jump host and no forwards.

ALTER TABLE ssh_hosts ADD COLUMN jump_host_id TEXT REFERENCES ssh_hosts(id) ON DELETE SET NULL;
ALTER TABLE ssh_hosts ADD COLUMN forwards_json TEXT NOT NULL DEFAULT '[]';
