import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // An activation records the lease that last authorized it. Persistent and
  // warm activations intentionally outlive that short-lived Run lease, so the
  // identifier is audit metadata rather than a live parent relation.
  await sql`
    alter table sandbox_manager_activations
      drop constraint sandbox_manager_activations_lease_id_fkey
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    delete from sandbox_manager_activations as activation
     where not exists (
       select 1
         from session_leases as lease
        where lease.lease_id = activation.lease_id
     )
  `.execute(db);
  await sql`
    alter table sandbox_manager_activations
      add constraint sandbox_manager_activations_lease_id_fkey
      foreign key (lease_id) references session_leases (lease_id)
  `.execute(db);
}
