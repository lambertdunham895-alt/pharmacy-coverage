-- ============================================================
-- Pharmacist Coverage — database schema
-- Run this once in Supabase: SQL Editor -> New query -> Run
-- ============================================================

-- ---------- Tables ----------

create table if not exists public.locations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  abbrev      text not null,
  color       text not null default '#38bdf8',
  sort_order  int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default 'New pharmacist',
  initials    text not null default '??',
  role        text not null default 'pharmacist' check (role in ('pharmacist','manager')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.shifts (
  id            uuid primary key default gen_random_uuid(),
  shift_date    date not null,
  location_id   uuid not null references public.locations(id) on delete cascade,
  pharmacist_id uuid references public.profiles(id) on delete set null,
  start_time    time not null,
  end_time      time not null,
  notes         text,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists shifts_date_idx on public.shifts (shift_date);
create index if not exists shifts_pharmacist_idx on public.shifts (pharmacist_id);

-- ---------- Auto-create a profile when a user is invited ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, initials)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    upper(left(coalesce(new.raw_user_meta_data->>'full_name', new.email), 2))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Helper: is the current user a manager? ----------
-- security definer so the policies below don't recurse on profiles

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'manager' and active
  );
$$;

-- ---------- Row Level Security ----------

alter table public.locations enable row level security;
alter table public.profiles  enable row level security;
alter table public.shifts    enable row level security;

-- Everyone signed in can read. Only managers can change things.

drop policy if exists locations_read on public.locations;
create policy locations_read on public.locations
  for select to authenticated using (true);

drop policy if exists locations_write on public.locations;
create policy locations_write on public.locations
  for all to authenticated using (public.is_manager()) with check (public.is_manager());

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles p where p.id = auth.uid()));

drop policy if exists profiles_manage on public.profiles;
create policy profiles_manage on public.profiles
  for all to authenticated using (public.is_manager()) with check (public.is_manager());

drop policy if exists shifts_read on public.shifts;
create policy shifts_read on public.shifts
  for select to authenticated using (true);

drop policy if exists shifts_write on public.shifts;
create policy shifts_write on public.shifts
  for all to authenticated using (public.is_manager()) with check (public.is_manager());

-- ---------- Seed the four stores (edit these names) ----------

insert into public.locations (name, abbrev, color, sort_order)
select * from (values
  ('Main Street',   'MAIN', '#4f9dff', 1),
  ('Oak Ridge',     'OAK',  '#3fbf8f', 2),
  ('Westside',      'WEST', '#c78cf0', 3),
  ('South Clinic',  'SOUT', '#e0a44c', 4)
) as v(name, abbrev, color, sort_order)
where not exists (select 1 from public.locations);

-- ============================================================
-- AFTER you create your own login, make yourself a manager:
--
--   update public.profiles set role = 'manager'
--   where id = (select id from auth.users where email = 'you@example.com');
-- ============================================================
