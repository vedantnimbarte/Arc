-- Terminal scrollback restore was removed; drop the buffers it left behind.
DELETE FROM app_settings WHERE key LIKE 'scrollback:%';
