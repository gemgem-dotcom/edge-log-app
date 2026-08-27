-- ============================================================
-- Screenshot storage setup — run this in Supabase SQL Editor.
-- Safe to run multiple times (uses ON CONFLICT / IF NOT EXISTS, and every
-- policy is dropped and recreated).
--
-- This fixes "Screenshot upload failed: Bucket not found" — that
-- error means the 'screenshots' bucket was never created (or was
-- created under a different name) in this Supabase project.
--
-- The bucket is PRIVATE, not public. A screenshot a user uploads must only
-- ever be viewable by that same user, verified through their actual login
-- - never through a permanent or guessable link that works regardless of
-- who's asking (see NOTES.md's "Uploaded files must be private and
-- per-user" for the full standing rule this follows). Every object lives
-- under a `{user_id}/...` path (lib/screenshots.js's uploadScreenshots),
-- and the policies below scope read/write access to a user's own prefix,
-- the same auth.uid() = user_id pattern every table's row level security
-- already uses in schema.sql, applied here to storage object paths
-- instead of table rows. The app reads screenshots through short-lived
-- signed URLs generated at render time (lib/screenshots.js's
-- getScreenshotUrls), never a stored permanent URL - createSignedUrl
-- itself is subject to the SELECT policy below, so requesting a signed
-- URL for a path you don't own fails the same way a direct read would.
--
-- If this bucket was created before this file existed (public, flat
-- {timestamp}-{random}.ext paths, no ownership prefix), run
-- scripts/migrate-screenshots-to-private.js once after this SQL to move
-- every existing trade's screenshots under their owner's own path and
-- update `trades.screenshot_urls` to the new paths - this SQL alone does
-- not migrate existing objects.
-- ============================================================

-- Create the bucket itself. `public = false` on an already-existing bucket
-- isn't touched by `on conflict do nothing` - if this bucket already
-- exists as public, run `update storage.buckets set public = false where
-- id = 'screenshots';` by hand once, after confirming the migration
-- script (above) has moved every existing screenshot to its new
-- per-user path first.
insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', false)
on conflict (id) do nothing;

-- Allow an authenticated user to upload only under their own user-id
-- prefix - (storage.foldername(name))[1] is the first path segment (the
-- part before the first '/'), which lib/screenshots.js's uploadScreenshots
-- always sets to the uploading user's own auth.uid().
drop policy if exists "Authenticated users can upload screenshots" on storage.objects;
create policy "Users can upload their own screenshots"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text);

-- A user can only read objects under their own path prefix - this is the
-- actual isolation guarantee (a private bucket alone doesn't provide it;
-- every object in a public bucket is viewable by anyone with its URL
-- regardless of folder). createSignedUrl checks this same policy before
-- issuing a URL, so generating a signed URL for someone else's path fails
-- here rather than at some later step.
drop policy if exists "Anyone can view screenshots" on storage.objects;
drop policy if exists "Users can view their own screenshots" on storage.objects;
create policy "Users can view their own screenshots"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text);

-- A user can only delete their own screenshots - needed if a trade with a
-- screenshot is ever deleted, or a screenshot is replaced, same scoping
-- as insert/select above rather than any-authenticated-user-can-delete.
drop policy if exists "Authenticated users can delete screenshots" on storage.objects;
drop policy if exists "Users can delete their own screenshots" on storage.objects;
create policy "Users can delete their own screenshots"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text);
