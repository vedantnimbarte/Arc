-- User-configurable app settings (non-secret). A simple key→JSON-value
-- store so we can add new setting keys without new migrations.

CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT    PRIMARY KEY NOT NULL,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);
