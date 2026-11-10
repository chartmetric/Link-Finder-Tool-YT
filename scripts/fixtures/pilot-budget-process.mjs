// Forked fixture: no inherited provider credentials, no external HTTP.
import pg from 'pg';
import fs from 'node:fs/promises';
import {createPostgresPilotCoordinator} from '../src/instagram-pilot-shared-budget.mjs';
import {createPilotBudget} from '../src/instagram-pilot-budget.mjs';

process.once('message', async options => {
  const pool = new pg.Pool({host:options.socket, port:options.port, user:options.user, database:'postgres'});
  const coordinator = createPostgresPilotCoordinator(pool);
  let budget;
  try {
    const manifest = {
      run_allowed:true,
      authorization:{approved:true, maxSpendCents:options.cap ?? 10,
        priorReservedCents:options.prior, runId:options.runId},
      artists:[{profile_id:'1',source_identity_matches:true,reference_preflight:{readiness:'reference_usable'}}],
      proposed_limits:{serper_requests_total:10,serper_requests_per_artist:10,
        scrapecreators_requests_total:0,instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,
        jev_requests_total:0,jev_requests_per_artist:0,paid_http_requests_total:10,
        public_spotify_oembed_requests_total:0,public_official_or_linkhub_page_requests_total:0,
        public_http_requests_total:0,public_music_page_requests_per_artist:1,
        global_concurrent_provider_requests:1,per_request_timeout_seconds:1,
        jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000},
    };
    // "live" admission exercises real prices and the real PG gate, but dispatch
    // is a local receipt file, NEVER a provider transport.
    budget = await createPilotBudget({manifest, sharedCoordinator:coordinator,
      journalPath:options.journal, mode:'live', transport:{live:true, dispatch:async () => {
        await fs.appendFile(options.receipts, `${options.runId}\n`);
        if (options.crash) process.exit(9);
        if (options.timeout) return new Promise(() => {});
        if (options.fail) throw Error('Fixture uncertain dispatch');
        return {fixture:true};
      }}});
    process.send({phase:'ready'});
    await new Promise(resolve => process.once('message', resolve));
    for (let i=0; i<(options.requests ?? 1); i++) {
      await budget.request({profileId:'1', kind:'serper', key:`request-${i}`});
    }
    process.send({phase:'done',snapshot:budget.snapshot()});
  } catch (error) {
    process.send({phase:'error',message:error.message});
  } finally {
    try { await budget?.close(); } finally { await pool.end(); process.disconnect(); }
  }
});
