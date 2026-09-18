-- Supabase-only hardening: RLS, Realtime publication and the Storage bucket.
-- Run in the Supabase SQL editor *after* SUPABASE_SCHEMA.sql.
-- Admins provision users manually (no public signup), so every policy is
-- "owner can read their own rows" and writes come from the service role only.

-- --------------------------------------------------------------------------
-- Row level security
-- --------------------------------------------------------------------------
alter table resumes            enable row level security;
alter table vacancies          enable row level security;
alter table applications       enable row level security;
alter table model_availability enable row level security;
alter table app_settings       enable row level security;

-- Workers use the service-role key, which bypasses RLS. These policies only
-- grant end users read access to their own data (Dashboard / Chrome Extension).
drop policy if exists resumes_owner_read on resumes;
create policy resumes_owner_read on resumes
    for select using (auth.uid()::text = user_id);

drop policy if exists vacancies_owner_read on vacancies;
create policy vacancies_owner_read on vacancies
    for select using (auth.uid()::text = user_id);

drop policy if exists applications_owner_read on applications;
create policy applications_owner_read on applications
    for select using (auth.uid()::text = user_id);

-- model_availability / app_settings stay invisible to end users: no policies
-- means "deny" for anon/authenticated once RLS is enabled.

-- --------------------------------------------------------------------------
-- Realtime: the dashboard subscribes to status changes on resumes.
-- --------------------------------------------------------------------------
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        begin
            execute 'alter publication supabase_realtime add table resumes';
        exception when duplicate_object then
            null; -- already part of the publication
        end;
    end if;
end
$$;

-- --------------------------------------------------------------------------
-- Storage: private bucket holding the master CV and every tailored artifact.
--   master/cv.docx            master CV (input contract)
--   master/cv_data.json       structured CV knowledge base
--   tailored/<user>/<id>.pdf  worker output (signed URLs are handed to the UI)
-- --------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', false)
on conflict (id) do nothing;

-- Only the service role (worker/gateway) writes; owners may read their folder.
drop policy if exists resumes_objects_owner_read on storage.objects;
create policy resumes_objects_owner_read on storage.objects
    for select using (
        bucket_id = 'resumes'
        and (storage.foldername(name))[2] = auth.uid()::text
    );
