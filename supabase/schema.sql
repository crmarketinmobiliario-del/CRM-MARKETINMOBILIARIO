create table if not exists public.crm_leads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid()
    references auth.users(id) on delete cascade,

  name text not null check (length(trim(name)) > 0),
  phone text,
  email text,
  budget numeric(14,2) check (budget is null or budget >= 0),

  client_type text not null check (
    client_type in (
      'Comprador',
      'Propietario vendedor',
      'Busca renta',
      'Ofrece renta',
      'Aportante o inversionista'
    )
  ),
  operation text not null check (
    operation in ('Compra', 'Venta', 'Renta', 'Aportación')
  ),
  credit_type text not null default '' check (
    credit_type in ('', 'Infonavit', 'FOVISSSTE', 'Bancario', 'Recursos propios')
  ),
  property_type text not null default '' check (
    property_type in ('', 'Casa', 'Departamento', 'Terreno', 'Hectárea')
  ),
  zone_type text not null default '' check (
    zone_type in ('', 'Ciudad', 'Playa', 'Montaña', 'Comunidad')
  ),
  zone text,
  source text not null default 'Captura manual' check (
    source in ('Captura manual', 'Libreta', 'WhatsApp', 'Messenger', 'Marketplace', 'Referido', 'Otro')
  ),
  stage text not null default 'Interés',

  start_date date,
  next_contact timestamptz,
  next_channel text not null default 'Llamada' check (
    next_channel in ('Llamada', 'WhatsApp', 'Messenger', 'Otro')
  ),
  target_date date,
  rent_start date,
  rent_end date,
  check (rent_start is null or rent_end is null or rent_end >= rent_start),

  comments text not null default '',
  whatsapp_opt_in boolean not null default false,
  activities jsonb not null default '[]'::jsonb
    check (jsonb_typeof(activities) = 'array'),
  last_contact_at timestamptz,
  archived boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists crm_leads_owner_next_contact_idx
  on public.crm_leads (owner_id, next_contact);

create index if not exists crm_leads_owner_stage_idx
  on public.crm_leads (owner_id, stage);

alter table public.crm_leads enable row level security;

revoke all on table public.crm_leads from anon, public;
grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.crm_leads to authenticated;

drop policy if exists crm_leads_select_own on public.crm_leads;
create policy crm_leads_select_own
  on public.crm_leads for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists crm_leads_insert_own on public.crm_leads;
create policy crm_leads_insert_own
  on public.crm_leads for insert to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists crm_leads_update_own on public.crm_leads;
create policy crm_leads_update_own
  on public.crm_leads for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists crm_leads_delete_own on public.crm_leads;
create policy crm_leads_delete_own
  on public.crm_leads for delete to authenticated
  using (owner_id = (select auth.uid()));

create or replace function public.crm_leads_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists crm_leads_updated_at on public.crm_leads;
create trigger crm_leads_updated_at
  before update on public.crm_leads
  for each row execute function public.crm_leads_set_updated_at();
