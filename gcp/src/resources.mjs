// A standalone workload's resource on Google Cloud (vision standalone workloads design §2, §5): its path, as Google names it, and the
// router's backend kind it is. A Compute Engine VM `projects/<p>/zones/<z>/instances/<name>` (vm), a managed instance group
// `projects/<p>/zones|regions/<l>/instanceGroupManagers/<name>` (mig), a Cloud SQL instance `projects/<p>/instances/<name>`
// (cloudsql). Pure.
const VM = /^projects\/([a-z][-a-z0-9.:]{0,62})\/zones\/([a-z]+-[a-z]+[0-9]+-[a-z])\/instances\/([a-z]([-a-z0-9]{0,61}[a-z0-9])?)$/;
const MIG = /^projects\/([a-z][-a-z0-9.:]{0,62})\/(?:zones|regions)\/([a-z]+-[a-z]+[0-9]+(?:-[a-z])?)\/instanceGroupManagers\/([a-z]([-a-z0-9]{0,61}[a-z0-9])?)$/;
const SQL = /^projects\/([a-z][-a-z0-9.:]{0,62})\/instances\/([a-z]([-a-z0-9]{0,96}[a-z0-9])?)$/;

// `{ kind, project, location?, name }`, or null for a path that is none of them.
export function resourceOf(path) {
  if (typeof path !== 'string') return null;
  let m = VM.exec(path);
  if (m) return { kind: 'vm', project: m[1], location: m[2], name: m[3] };
  m = MIG.exec(path);
  if (m) return { kind: 'mig', project: m[1], location: m[2], name: m[3] };
  m = SQL.exec(path);
  if (m) return { kind: 'cloudsql', project: m[1], name: m[2] };
  return null;
}
