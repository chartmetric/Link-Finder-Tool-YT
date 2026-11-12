import {readFile, readdir, stat} from "node:fs/promises";
import path from "node:path";
import {hostname} from "node:os";

type RequestEvidence = {at: string; status: string};

// Read-only request evidence, not proof that a worker is alive. Never launch work.
export async function continuationRequest(root: string, queueIds: Set<string>, runUpdatedAt: string) {
  const dirs = await readdir(root, {withFileTypes:true});
  let newest: RequestEvidence | null = null;
  let newestRequest = "";
  for (const dir of dirs) {
    if (!dir.isDirectory() || !/^parallel-[a-f0-9-]{36}$/.test(dir.name)) continue;
    const file = path.join(root,dir.name,"tier-exception-scope.json");
    try {
      const stamp = (await stat(file)).mtime.toISOString();
      if (stamp <= runUpdatedAt || stamp <= newestRequest) continue;
      const rows = JSON.parse(await readFile(file,"utf8"));
      if (!Array.isArray(rows) || rows.length !== 9404) continue;
      const ids = rows.map((r: {profile_id?: unknown})=>r?.profile_id);
      if (new Set(ids).size !== 9404 || !ids.every(id=>typeof id === "string" && queueIds.has(id))) continue;
      // A launch attempt is not a coordinator checkpoint. Until the coordinator
      // advances, keep newer preparation evidence instead of regressing its clock.
      let launchAt: string | null = null;
      try {launchAt = (await stat(path.join(root,dir.name,"launch-attempt.json"))).mtime.toISOString();}
      catch(e: any) {if(e.code !== "ENOENT")throw e;}
      let evidence: RequestEvidence = {at: launchAt ?? stamp,
        status: launchAt ? "continuation_launching" : "continuation_requested"};
      try {
        const marker = JSON.parse(await readFile(path.join(root,dir.name,"preparation-status.json"),"utf8"));
        if (marker.version !== 1 || marker.phase !== dir.name
          || !["preparing","prepared","launching","failed","interrupted","handed_off"].includes(marker.status)
          || !Number.isFinite(Date.parse(marker.at)) || !Number.isFinite(Date.parse(marker.startedAt))
          || Date.parse(marker.at) < Date.parse(marker.startedAt)) {
          throw Error("Invalid continuation preparation evidence.");
        }
        let status = marker.status;
        if (!["failed","interrupted","handed_off"].includes(status)
          && marker.hostname === hostname() && Number.isSafeInteger(marker.pid) && marker.pid > 0) {
          // A local preparer's disappearance is NOT a statement about the worker.
          try {process.kill(marker.pid, 0);}
          catch(e: any) {if(e.code === "ESRCH") status = "interrupted"; else if(e.code !== "EPERM") throw e;}
        }
        evidence = {
          at: new Date(Math.max(Date.parse(stamp), Date.parse(marker.at), Date.parse(launchAt ?? stamp))).toISOString(),
          status: status === "failed" ? "continuation_preparation_failed"
            : status === "interrupted" ? "continuation_preparation_interrupted"
            : launchAt || ["launching","handed_off"].includes(status) ? "continuation_launching" : "continuation_requested",
        };
      } catch(e: any) {if(e.code !== "ENOENT")throw e;}
      // Select by request time, not exit time: an older preparer can exit later.
      newestRequest = stamp;
      newest = evidence;
    } catch(e: any) {if(e.code !== "ENOENT")throw e;}
  }
  return newest;
}
