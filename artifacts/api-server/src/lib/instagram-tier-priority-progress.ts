// Read-only handoff observer. No executor, provider, admission, or schema imports.
import {readFile} from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import {pool} from "@workspace/db";
import {CAMPAIGN_ID, CAMPAIGN_QUEUE_SHA256, CAMPAIGN_DIRECTORY, artistTotals} from "./artist-campaign-model";
import {validateCampaignSnapshot, type CampaignSnapshot} from "./artist-campaign-snapshot";
import {continuationRequest} from "./instagram-continuation-status";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
export async function captureTierPrioritySnapshot(workspace: string): Promise<CampaignSnapshot | null> {
  const root = path.join(workspace, "generated-artifacts/instagram-tier-priority");
  let approval: any;
  try { approval = await json(path.join(root, "approval.json")); }
  catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
  const queue = await json(path.join(root, "queue.json"));
  const original = await json(path.join(workspace, CAMPAIGN_DIRECTORY, "approval.json"));
  const spending = await json(path.join(workspace, CAMPAIGN_DIRECTORY, "uncapped-approval.json"));
  const baseline = await json(path.join(root, "baseline.json"));
  assert.equal(approval.id, CAMPAIGN_ID);
  assert.equal(approval.maximumSpendCents, null);
  assert.equal(approval.order, "tier_1_then_2_then_3_then_4_then_5");
  assert.equal(approval.originalQueueSha256, CAMPAIGN_QUEUE_SHA256);
  assert.equal(original.queueSha256, CAMPAIGN_QUEUE_SHA256);
  assert.equal(spending.originalApprovalSha256, hash(original));
  assert.equal(spending.maximumSpendCents, null);
  assert.equal(spending.uncappedExplicitlyApproved, true);
  assert.equal(hash(spending), approval.parentScopeSha256);
  assert.equal(hash(queue), approval.scopeSha256);
  assert.equal(hash(baseline), approval.baselineSha256);
  assert.equal(queue.length, approval.originalQueueArtists);
  const bindings = new Map<string, any>(queue.map((a: any) => [String(a.profile_id), a] as const));
  assert.equal(bindings.size, queue.length);
  for (const a of baseline) assert.equal(String(bindings.get(a.profileId)?.cm_artist), a.cmArtist);
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const p = (await c.query("SELECT * FROM instagram_priority_runs WHERE id=$1", [CAMPAIGN_ID])).rows[0];
    assert.ok(p); assert.equal(p.scope_sha256, approval.scopeSha256);
    assert.equal(p.approval_sha256, hash(approval)); assert.equal(p.maximum_spend_cents, null);
    const old = (await c.query(`SELECT p.owner,p.scope_sha256,p.cap_cents,sum(b.reserved_cents)::int reserved
      FROM instagram_campaign_budgets p JOIN instagram_campaign_children ch ON ch.campaign_id=p.id
      JOIN instagram_saved_batch_budgets b ON b.id=ch.budget_id WHERE p.id=$1 GROUP BY p.id`, [CAMPAIGN_ID])).rows[0];
    assert.equal(old.owner, approval.parentOwner); assert.equal(old.scope_sha256, approval.parentScopeSha256);
    assert.equal(old.cap_cents, null); assert.equal(old.reserved, approval.legacyReservedCents);
    const admitted = (await c.query("SELECT coalesce(sum(reserved_cents),0)::int reserved FROM instagram_priority_admissions WHERE campaign_id=$1", [CAMPAIGN_ID])).rows[0].reserved;
    assert.equal(Number(p.reserved_cents), admitted);
    const bound = (await c.query(`SELECT count(*)::int n FROM
      jsonb_to_recordset($2::jsonb) AS q(profile_id text,cm_artist text,tier int,ordinal int)
      JOIN instagram_priority_artists a ON a.campaign_id=$1 AND a.profile_id=q.profile_id
      AND a.cm_artist=q.cm_artist AND a.tier=q.tier AND a.ordinal=q.ordinal`,
      [CAMPAIGN_ID, JSON.stringify(queue.map((a: any, ordinal: number) => ({
        profile_id: String(a.profile_id), cm_artist: String(a.cm_artist), tier: Number(a.tier), ordinal,
      })))] )).rows[0].n;
    assert.equal(bound, queue.length, "Counter identities changed from the approved frozen queue.");
    const tiers = (await c.query(`SELECT tier,count(*)::int total,
      count(*) FILTER(WHERE status IN ('completed','failed'))::int processed,
      count(*) FILTER(WHERE checked)::int checked,count(*) FILTER(WHERE likely)::int likely
      FROM instagram_priority_artists WHERE campaign_id=$1 GROUP BY tier ORDER BY tier`, [CAMPAIGN_ID])).rows;
    assert.equal(tiers.length, 5);
    const tierBreakdown = tiers.map((row: any, index: number) => {
      assert.equal(row.tier, index + 1);
      assert.equal(row.total, queue.filter((a: any) => Number(a.tier) === row.tier).length);
      return {tier: row.tier, ...artistTotals(row.total, {
        processed: row.processed, checked: row.checked, likely: row.likely, reserved: 0,
      })};
    });
    const sum = (key: "total" | "processed" | "checked" | "likely") => tiers.reduce((n: number, t: any) => n + t[key], 0);
    assert.equal(sum("total"), queue.length);
    await c.query("COMMIT");
    const requestAt = p.status === "completed"
      ? await continuationRequest(root, new Set(bindings.keys()), new Date(p.updated_at).toISOString())
      : null;
    return validateCampaignSnapshot({
      version: 2, maximumSpendCents: null, authorizationSha256: hash(spending),
      campaignId: CAMPAIGN_ID, queueSha256: CAMPAIGN_QUEUE_SHA256,
      totalArtists: sum("total"), processed: sum("processed"), checked: sum("checked"), likely: sum("likely"),
      reserved: approval.legacyReservedCents + admitted,
      status: requestAt ? "continuation_requested" : p.status === "prepared" ? "stopped" : p.status,
      updatedAt: requestAt ?? new Date(p.updated_at).toISOString(), capturedAt: new Date().toISOString(),
      workerEnvironment: "workspace", tierBreakdown,
    });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}
