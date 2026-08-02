-- ============================================================
-- Screenshot storage setup — run this in Supabase SQL Editor.
-- Safe to run multiple times (uses ON CONFLICT / IF NOT EXISTS).
--
-- This fixes "Screenshot upload failed: Bucket not found" — that
-- error means the 'screenshots' bucket was never created (or was
-- created under a different name) in this Supabase project.
-- ============================================================

-- Create the bucket itself (public, so screenshot URLs work directly
-- without extra signed-URL logic).
insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', true)
on conflict (id) do nothing;

-- Allow any authenticated user to upload into this bucket.
drop policy if exists "Authenticated users can upload screenshots" on storage.objects;
create policy "Authenticated users can upload screenshots"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'screenshots');

-- Allow anyone to view screenshots (bucket is public, so this just
-- lets the public URLs actually resolve).
drop policy if exists "Anyone can view screenshots" on storage.objects;
create policy "Anyone can view screenshots"
  on storage.objects for select
  using (bucket_id = 'screenshots');

-- Allow authenticated users to delete screenshots (needed if a trade
-- with a screenshot is ever deleted, or a screenshot is replaced).
drop policy if exists "Authenticated users can delete screenshots" on storage.objects;
create policy "Authenticated users can delete screenshots"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'screenshots');
