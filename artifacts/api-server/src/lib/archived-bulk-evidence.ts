import { lstat, readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import type { ArchivedBulkEvidenceRecord } from "@workspace/api-zod";

const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const text = (value: unknown) => typeof value === "string" ? value : undefined;

/** Only project-local archives are read. No provider calls or archive writes. */
async function archiveRoot() {
  let dir = process.cwd();
  while (true) {
    try { await access(path.join(dir, "pnpm-workspace.yaml")); return path.join(dir, "generated-artifacts"); }
    catch { const parent = path.dirname(dir); if (parent === dir) throw new Error("Workspace root unavailable"); dir = parent; }
  }
}

async function readSavedJson(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("Archive file is unavailable or exceeds the read limit");
  return readFile(file, "utf8");
}

/** Projection of saved facts only; never recompute signals with today's code. */
export function projectArchivedEvidence(raw: unknown, packet?: unknown): ArchivedBulkEvidenceRecord {
  const r = object(raw), partial = object(r.partialEvidence);
  const state = object(object(object(packet).decisionRequest).state);
  const savedDelivery = r.contextDelivery ?? partial.contextDelivery;
  const delivery = savedDelivery ?? state.contextDelivery;
  const signals = array(object(state.artistContext).candidateSignals);
  const requestCandidates = array(state.candidates);
  const savedCandidates = array(object(r.rawResult).profiles ?? partial.profiles);
  const candidates = savedCandidates.map(p => ({
    url: String(p.url ?? ""),
    verdict: text(object(p.jevVerification).verdict),
    sameIdentityProbability: typeof object(p.jevVerification).sameIdentityProbability === "number"
      ? p.jevVerification.sameIdentityProbability : undefined,
  }));
  const perCandidate = requestCandidates.flatMap((p, i) => {
    const diagnostics = object(signals[i]?.songTitlesInCandidatePosts).diagnostics;
    return typeof p.url === "string" && diagnostics ? [{ url:p.url, diagnostics }] : [];
  });
  // Archived request signals are already serialized evidence, not a reconstruction.
  const contextDelivery = delivery || perCandidate.length
    ? { ...object(delivery), ...(object(delivery).candidatePostDiagnostics ? {}
      : perCandidate.length ? {candidatePostDiagnostics:perCandidate} : {}) } : undefined;
  return {
    profileId: String(r.profileId ?? ""), subject: text(state.artist),
    status: text(r.status) ?? "unknown", reason: text(r.reason), candidates,
    contextDelivery,
    deliverySource: savedDelivery ? "saved_result" : contextDelivery ? "archived_request" : "not_recorded",
  };
}

export async function readArchivedBulkEvidence(archive: string | undefined, page: number, root?: string) {
  root ??= await archiveRoot();
  let dirs;
  try { dirs = await readdir(root, { withFileTypes:true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {archives:[],records:[],page,hasMore:false}; throw error; }
  const archives: string[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || !/^instagram-bulk-shadow-[a-zA-Z0-9-]+$/.test(dir.name)) continue;
    try { if ((await lstat(path.join(root, dir.name, "results.jsonl"))).isFile()) archives.push(dir.name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  archives.sort();
  const selected = archive ?? archives[0];
  if (selected && !archives.includes(selected)) throw new Error("INVALID_ARCHIVE");
  if (!selected) return {archives,records:[],page,hasMore:false};
  const dir = path.join(root, selected);
  const lines = (await readSavedJson(path.join(dir,"results.jsonl"))).split("\n").filter(line => line.trim());
  const start = (page-1)*20;
  let responseFiles: string[] = [];
  try { responseFiles = (await readdir(path.join(dir,"responses"),{withFileTypes:true}))
    .filter(f=>f.isFile()).map(f=>f.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const records = await Promise.all(lines.slice(start,start+20).map(async line => {
    const raw = JSON.parse(line);
    const id = String(raw.profileId ?? "");
    const packets = /^\d+$/.test(id) ? responseFiles.filter(f=>new RegExp(`^${id}-jev-\\d+\\.json$`).test(f)) : [];
    let packet: unknown;
    let warning: string | undefined;
    if (packets.length === 1) {
      try { packet = JSON.parse(await readSavedJson(path.join(dir,"responses",packets[0]))); }
      catch { warning = "The archived request packet could not be read. Showing saved result diagnostics only."; }
    } else if (packets.length > 1) warning = "Multiple archived requests exist; no request diagnostics were selected automatically.";
    return {...projectArchivedEvidence(raw,packet), ...(warning ? {warning} : {})};
  }));
  return {archives,archive:selected,records,page,hasMore:lines.length>start+20};
}
