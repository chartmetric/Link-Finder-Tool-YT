// Read-only upstream refresh audit. Does not import campaign workers or paid providers.
import fs from 'node:fs/promises';
import path from 'node:path';
import {catalogSelect} from './campaign-parallel-catalog.mjs';

const output = process.argv[2];
if (!output?.startsWith('generated-artifacts/') || output.includes('..')) {
  throw Error('Provide a new generated-artifacts/ evidence directory');
}
await fs.mkdir(output, {recursive: true});
const metadataQueries = {
  clock: `SELECT toString(now(), 'UTC') AS observed_at_utc, timezone() AS server_timezone`,
  producer_tables: `SELECT database, name, engine, comment
    FROM system.tables WHERE database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
    AND (positionCaseInsensitive(name,'tier')>0 OR match(lower(name),'job|task|schedul|pipeline|etl|refresh|run_log'))
    ORDER BY database,name LIMIT 150`,
  tier_columns: `SELECT name,type,default_kind,comment FROM system.columns
    WHERE database='new_vertical' AND table='l_profile_tier' ORDER BY position`,
  system_evidence_columns: `SELECT table,name,type FROM system.columns WHERE database='system'
    AND table IN ('query_log','part_log','mutations','view_refreshes','text_log')
    AND name IN ('event_time','event_date','type','query_kind','tables','exception_code','exception',
      'written_rows','read_rows','query_duration_ms','query','initial_query_id','query_id',
      'database','table','event_type','rows','error','exception','status','last_success_time',
      'last_refresh_time','next_refresh_time','result_part_name')
    ORDER BY table,position`,
  tier_shape: `SELECT engine,sorting_key,primary_key,partition_key,dependencies_database,dependencies_table
    FROM system.tables WHERE database='new_vertical' AND name='l_profile_tier'`,
  global_tier_dates: `SELECT toString(computed_at,'UTC') AS computed_at_utc,
    count() AS rows,uniqExact(profile) AS artists,
    min(toString(updated_at,'UTC')) AS earliest_updated_at_utc,
    max(toString(updated_at,'UTC')) AS latest_updated_at_utc
    FROM new_vertical.l_profile_tier FINAL WHERE grain='global' AND profile_type='musician'
    GROUP BY computed_at ORDER BY computed_at DESC LIMIT 15`,
};
const producerQueries = {
  producer_columns: `SELECT table,name,type,comment FROM system.columns
    WHERE database='new_vertical' AND table IN
    ('scheduled_jobs','scheduled_job_runs','refresh_log','aod_refresh_log',
     'ingestion_jobs','job_profile_results','tasks','tier')
    ORDER BY table,position`,
  system_log_inventory: `SELECT name,engine FROM system.tables WHERE database='system'
    AND (positionCaseInsensitive(name,'log')>0 OR name IN ('mutations','view_refreshes'))
    ORDER BY name`,
  views_inventory: `SELECT database,name,engine FROM system.tables
    WHERE database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
    AND (positionCaseInsensitive(engine,'view')>0 OR has(dependencies_table,'l_profile_tier'))
    ORDER BY database,name LIMIT 100`,
};
const jobQueries = {
  global_tier_config: `SELECT profile_type,grain,active,description,toString(updated_at,'UTC') AS updated_at_utc
    FROM new_vertical.tier FINAL WHERE profile_type='musician' AND grain='global' LIMIT 10`,
  scheduled_tier_jobs: `SELECT toString(id) AS job_id,name,mode,schedule_type,is_active,is_deleted,
    toString(next_run_at,'UTC') AS next_run_at_utc,toString(updated_at,'UTC') AS updated_at_utc
    FROM new_vertical.scheduled_jobs FINAL
    WHERE match(lower(concat(name,' ',question,' ',execution_plan)),'tier|l_profile_tier')
    ORDER BY updated_at DESC LIMIT 40`,
  scheduled_runs_inventory: `SELECT status,count() AS runs,min(toString(ran_at,'UTC')) AS earliest_utc,
    max(toString(ran_at,'UTC')) AS latest_utc
    FROM new_vertical.scheduled_job_runs FINAL
    WHERE ran_at>=toDateTime('2026-11-09 00:00:00','UTC')
    AND ran_at<toDateTime('2026-11-12 00:35:13','UTC')
    GROUP BY status ORDER BY status`,
  ingestion_job_types: `SELECT job_type,status,count() AS jobs,
    min(toString(started_at,'UTC')) AS first_started_at_utc,
    max(toString(started_at,'UTC')) AS last_started_at_utc,
    sum(profiles_success) AS profiles_success,sum(profiles_skipped) AS profiles_skipped,
    sum(profiles_errored) AS profiles_errored
    FROM new_vertical.ingestion_jobs FINAL
    WHERE started_at>=toDateTime('2026-11-09 00:00:00','UTC')
    AND started_at<toDateTime('2026-11-12 00:35:13','UTC')
    GROUP BY job_type,status ORDER BY job_type,status LIMIT 100`,
  tier_ingestion_history: `SELECT toString(id) AS job_id,job_type,status,
    toString(started_at,'UTC') AS started_at_utc,toString(completed_at,'UTC') AS completed_at_utc,
    profiles_success,profiles_skipped,profiles_errored
    FROM new_vertical.ingestion_jobs FINAL WHERE positionCaseInsensitive(job_type,'tier')>0
    ORDER BY started_at DESC LIMIT 30`,
  refresh_log_categories: `SELECT entity,step,status,trigger,count() AS events,uniqExact(run_id) AS runs,
    min(toString(refreshed_at,'UTC')) AS first_event_utc,
    max(toString(refreshed_at,'UTC')) AS last_event_utc
    FROM new_vertical.refresh_log
    WHERE refreshed_at>=toDateTime('2026-11-09 00:00:00','UTC')
    AND refreshed_at<toDateTime('2026-11-12 00:35:13','UTC')
    GROUP BY entity,step,status,trigger ORDER BY events DESC LIMIT 100`,
  tier_refresh_log_matches: `SELECT run_id,toString(refreshed_at,'UTC') AS refreshed_at_utc,
    entity,trigger,step,status,left(reason,1500) AS reason,duration_ms
    FROM new_vertical.refresh_log
    WHERE refreshed_at>=toDateTime('2026-11-09 00:00:00','UTC')
    AND refreshed_at<toDateTime('2026-11-12 00:35:13','UTC')
    AND match(lower(concat(entity,' ',step,' ',reason)),'tier|l_profile_tier')
    ORDER BY refreshed_at LIMIT 60`,
  query_log_probe: `SELECT type,query_kind,count() AS events,sum(written_rows) AS written_rows
    FROM system.query_log
    WHERE event_date>=toDate('2026-11-09') AND event_date<=toDate('2026-11-11')
    AND has(tables,'new_vertical.l_profile_tier') GROUP BY type,query_kind LIMIT 20`,
};
const phase = process.argv[3] ?? 'metadata';
const queries = {metadata:metadataQueries, producer:producerQueries, jobs:jobQueries}[phase];
if (!queries) throw Error('Unknown audit phase');
for (const [name, query] of Object.entries(queries)) {
  const queryFile = path.join(output, `${name}-query.sql`);
  await fs.writeFile(queryFile, query + '\n', {flag:'wx'});
  try {
    const rows = await catalogSelect(query, {queryKind: 'tier_refresh_audit'});
    await fs.writeFile(path.join(output,`${name}-rows.json`), JSON.stringify(rows,null,2)+'\n', {flag:'wx'});
    console.log(name, JSON.stringify(rows));
  } catch (error) {
    const safe = {unavailable:true, code:error.code ?? 'UNKNOWN', diagnostic:error.catalogDiagnostic ?? null};
    await fs.writeFile(path.join(output,`${name}-error.json`), JSON.stringify(safe,null,2)+'\n', {flag:'wx'});
    console.log(name, JSON.stringify(safe));
  }
}
