-- =========================================================================
-- KoshAgar ERP - 56_profile_columns.sql
--
-- A PROFILE ROW IS YOURS TO NAME, NOT TO REWRITE
--
-- 17_auth_profiles.sql grants UPDATE on the whole profiles table:
--
--   grant select, update on profiles to authenticated;
--
-- The row-level policy is right - a user may only touch their own row - but
-- "their own row" still includes columns that are not theirs to set. email is a
-- copy of the address the account was created with, kept so the login screen
-- can turn a user id into something Supabase Auth will accept. user_id is the
-- link to the account itself.
--
-- WHAT THAT ALLOWS, AND WHY IT IS WORTH CLOSING
-- A signed-in user can write any address into their own profiles.email. It does
-- not change the address they sign in with - that lives in auth.users, which no
-- policy here exposes - so nobody can take over an account this way. What it
-- does is poison the lookup: resolve_login_identifier() reads this column, so a
-- reset code asked for under that user id would be emailed to whatever address
-- was written there. The damage is limited and the effort is one statement.
--
-- Postgres grants privileges per COLUMN as readily as per table, so the fix is
-- to grant only the column a person is meant to change. change_username() stays
-- the sensible route - it checks the format and settles clashes - but a direct
-- update now cannot reach anything else.
-- =========================================================================

revoke update on profiles from authenticated;
grant  update (username, full_name) on profiles to authenticated;

comment on column profiles.email is
  'The address the account was created with, copied here so a user id can be resolved to something Supabase Auth accepts. Written by handle_new_user() only - not updatable from the API (56_profile_columns.sql).';

select 'a profile owner can change their name and user id, and nothing else' as note;
