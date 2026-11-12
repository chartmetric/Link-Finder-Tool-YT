import {readFile, readdir, stat} from "node:fs/promises";
import path from "node:path";

// Read-only request evidence, not proof that a worker is alive. Never launch work.
export async function continuationRequest(root: string, queueIds: Set<string>, runUpdatedAt: string) {
  const dirs = await readdir(root, {withFileTypes:true});
  let newest: string | null = null;
  for (const dir of dirs) {
    if (!dir.isDirectory() || !/^parallel-[a-f0-9-]{36}$/.test(dir.name)) continue;
    const file = path.join(root,dir.name,"tier-exception-scope.json");
    try {
      const stamp = (await stat(file)).mtime.toISOString();
      if (stamp <= runUpdatedAt || (newest && stamp <= newest)) continue;
      const rows = JSON.parse(await readFile(file,"utf8"));
      if (!Array.isArray(rows) || rows.length !== 9404) continue;
      const ids = rows.map((r: {profile_id?: unknown})=>r?.profile_id);
      if (new Set(ids).size !== 9404 || !ids.every(id=>typeof id === "string" && queueIds.has(id))) continue;
      // Once a phase attempts launch, the coordinator owns status reporting,
      // including any failure. Do not mask it with an old preparation request.
      try {await stat(path.join(root,dir.name,"launch-attempt.json"));continue;}
      catch(e: any) {if(e.code !== "ENOENT")throw e;}
      newest = stamp;
    } catch(e: any) {if(e.code !== "ENOENT")throw e;}
  }
  return newest;
}
