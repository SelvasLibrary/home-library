-- Home Library: database setup.
-- Run this once: Supabase → SQL Editor → New query → paste everything → Run.
-- It is safe to run again.

-- Tables: one row per book, passage and settings record, owned by your account.
create table if not exists public.books (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create table if not exists public.passages (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create table if not exists public.meta (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Only the signed-in owner can see or change their rows.
alter table public.books enable row level security;
alter table public.passages enable row level security;
alter table public.meta enable row level security;

drop policy if exists "Own books only" on public.books;
create policy "Own books only" on public.books for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Own passages only" on public.passages;
create policy "Own passages only" on public.passages for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Own settings only" on public.meta;
create policy "Own settings only" on public.meta for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on public.books, public.passages, public.meta to authenticated;

-- Cover photos: a storage bucket. Anyone with a cover's exact link can view it;
-- only you can upload or delete covers in your own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', true, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "Upload own covers" on storage.objects;
create policy "Upload own covers" on storage.objects for insert to authenticated
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Change own covers" on storage.objects;
create policy "Change own covers" on storage.objects for update to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Delete own covers" on storage.objects;
create policy "Delete own covers" on storage.objects for delete to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);

select 'Home Library setup finished' as result;
