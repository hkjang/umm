-- Reverses migrations/030_mail_deliveries.sql.
--
-- The record of what was sent goes with the table; a rolled-back binary does
-- not know how to read it anyway. The settings row goes too, so the relay
-- address and the encrypted password are not left behind in a row nothing
-- reads. A binary that still knows the setting treats the missing row as off.
DROP TABLE IF EXISTS mail_deliveries;
DELETE FROM app_settings WHERE key = 'mail';

DELETE FROM schema_migrations WHERE version = '030_mail_deliveries';
