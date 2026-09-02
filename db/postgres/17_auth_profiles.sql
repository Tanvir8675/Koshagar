-- =========================================================================
-- KoshAgar ERP — 17_auth_profiles.sql
--
-- Sign up with an email, a chosen user id and a password; verify by emailed
-- OTP; then sign in with EITHER the email or the user id.
--
-- Supabase Auth already provides email + password, the OTP, password change and
-- password reset. What it does not provide is signing in by a chosen handle -
-- signInWithPassword takes an email. So a profile row maps handle -> email, and
-- the login screen resolves one to the other before authenticating.
--
-- HOW THE HANDLE LOOKUP IS EXPOSED, AND WHAT IT COSTS
-- resolve_login_identifier() is callable before sign-in - it has to be, because
-- the browser needs the email to authenticate with. That means someone who
-- guesses a user id learns the email attached to it. There is no way to offer
-- handle-based login without that, so it is stated plainly rather than hidden:
--   * only an exact match returns anything, so handles cannot be listed;
--   * nothing else about the account is exposed - no name, no shop, no status;
--   * a wrong handle and a wrong password fail identically, so the form never
--     reveals which one was wrong.
-- =========================================================================

create table profiles (
  user_id     uuid        primary key references auth.users(id) on delete cascade,
  username    text        not null unique
                check (username = lower(username)
                       and username ~ '^[a-z0-9][a-z0-9_.]{2,29}$'),
  email       text        not null,
  full_name   text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index on profiles (lower(email));

comment on table profiles is
  'The handle a user signs in with, mapped to the email Supabase Auth authenticates. Lowercase only, so "Tasmim" and "tasmim" can never be two accounts.';

comment on column profiles.username is
  '3-30 characters, lowercase letters, digits, underscore and dot. Must start with a letter or digit.';

create trigger profiles_touch before update on profiles
  for each row execute function touch_updated_at();

-- =========================================================================
-- IS THIS HANDLE FREE?
--
-- Checked by the sign-up form before the account is created. Without it the
-- account would be made first and the profile would fail afterwards, leaving a
-- half-registered user who cannot sign in and cannot sign up again.
-- =========================================================================
create or replace function username_available(p_username text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v text := lower(trim(coalesce(p_username, '')));
begin
  if v !~ '^[a-z0-9][a-z0-9_.]{2,29}$' then
    return false;   -- malformed handles are never available
  end if;
  return not exists (select 1 from profiles where username = v);
end $$;

-- =========================================================================
-- HANDLE OR EMAIL -> EMAIL
--
-- The login screen passes whatever was typed. An email comes straight back so
-- the same code path serves both; a handle is looked up.
--
-- Returns null for an unknown handle. The client must then attempt the sign-in
-- anyway with a throwaway address, so that a wrong handle takes the same time
-- and gives the same message as a wrong password.
-- =========================================================================
create or replace function resolve_login_identifier(p_identifier text)
returns text language plpgsql stable security definer set search_path = public as $$
declare v text := lower(trim(coalesce(p_identifier, '')));
begin
  if v = '' then return null; end if;
  if position('@' in v) > 0 then return v; end if;   -- already an email
  return (select email from profiles where username = v);
end $$;

-- =========================================================================
-- SIGN UP
--
-- Supabase creates the auth user; this fires afterwards and completes the
-- account: a profile with the chosen handle, and the user's first shop.
--
-- The handle arrives in raw_user_meta_data, set by the client at signUp. If it
-- is missing or taken, the account is still created rather than failing the
-- signup outright - a handle is derived from the email and the user can change
-- it later. Losing a verified account over a name clash would be the worse
-- outcome.
-- =========================================================================
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_shop     uuid;
  v_username text;
  v_base     text;
  v_try      text;
  v_n        int := 0;
begin
  v_username := lower(trim(coalesce(new.raw_user_meta_data->>'username', '')));

  -- Fall back to the local part of the email, cleaned to fit the rules.
  if v_username !~ '^[a-z0-9][a-z0-9_.]{2,29}$' then
    v_base := regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9_.]', '', 'g');
    if length(v_base) < 3 then v_base := 'user' || v_base; end if;
    v_username := left(v_base, 30);
  end if;

  -- Settle any clash rather than failing the signup.
  v_try := v_username;
  while exists (select 1 from profiles where username = v_try) loop
    v_n := v_n + 1;
    v_try := left(v_username, 26) || v_n::text;
  end loop;

  insert into profiles (user_id, username, email, full_name)
  values (new.id, v_try, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', ''));

  -- The user's first shop.
  insert into shops (name) values ('KoshAgar') returning id into v_shop;
  insert into shop_members (shop_id, user_id, role) values (v_shop, new.id, 'owner');
  perform seed_new_shop(v_shop);

  return new;
end $$;

-- =========================================================================
-- CHANGE YOUR OWN HANDLE
-- The password is changed through Supabase Auth, not here.
-- =========================================================================
create or replace function change_username(p_new_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v text := lower(trim(coalesce(p_new_username, ''))); v_old text;
begin
  if auth.uid() is null then
    raise exception 'NOT_SIGNED_IN: sign in before changing your user id.';
  end if;
  if v !~ '^[a-z0-9][a-z0-9_.]{2,29}$' then
    raise exception 'INVALID_USERNAME: 3 to 30 characters, using letters, numbers, underscore or dot, starting with a letter or number.';
  end if;
  if exists (select 1 from profiles where username = v and user_id <> auth.uid()) then
    raise exception 'USERNAME_TAKEN: "%" is already in use.', v;
  end if;

  select username into v_old from profiles where user_id = auth.uid();
  update profiles set username = v where user_id = auth.uid();

  return jsonb_build_object('ok', true, 'username', v, 'previous', v_old);
end $$;

-- =========================================================================
-- RLS
--
-- A profile is readable only by its owner. The handle lookup above is a
-- SECURITY DEFINER function precisely so that it can answer without opening
-- the table to everyone.
-- =========================================================================
alter table profiles enable row level security;

create policy profiles_read_own on profiles for select
  using (user_id = auth.uid());
create policy profiles_update_own on profiles for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, update on profiles to authenticated;
grant all on profiles to service_role;

-- The two functions the login screen needs BEFORE anyone is signed in. These
-- are the only things anon may execute; everything else was revoked in
-- 16_lock_writes.sql and stays that way.
grant execute on function username_available(text)        to anon, authenticated;
grant execute on function resolve_login_identifier(text)  to anon, authenticated;
grant execute on function change_username(text)           to authenticated;
