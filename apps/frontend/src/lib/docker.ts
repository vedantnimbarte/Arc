/**
 * Docker: parsing and command construction for the containers panel.
 *
 * There is no `arc-docker` crate and there shouldn't be. Everything here runs
 * through the existing `proc_run` command, which already captures output and
 * suppresses the Windows console flash — a dedicated backend would add a crate
 * to re-implement exactly that.
 *
 * The only real design choice is the output format. `docker ps --format
 * '{{json .}}'` emits one JSON object per line, so "parsing" is
 * `JSON.parse` per line and there are no column-width or truncation games to
 * lose to. `docker compose ps --format json` is the same idea, except its
 * newer versions emit a single JSON array instead of NDJSON — handled below.
 *
 * ponytail: no log streaming and no image/volume/network management. Logs open
 * a terminal tab running `docker logs -f`, which is the same thing a stream
 * would give and costs no code. Add the rest if anyone runs the panel as their
 * only Docker UI.
 */

export interface Container {
  id: string;
  name: string;
  image: string;
  /** Raw status text, e.g. `Up 4 minutes`, `Exited (1) 2 hours ago`. */
  status: string;
  /** Published port bindings as docker prints them; empty when none. */
  ports: string;
  /** Compose project this belongs to, when it was started by compose. */
  project?: string;
  /** Compose service name, when applicable. */
  service?: string;
  running: boolean;
}

/** Verbs the panel can apply to a container. Constrained because the value
 *  reaches a command line. */
export type ContainerAction = 'start' | 'stop' | 'restart' | 'rm';

/**
 * Parse `docker ps --format {{json .}}` (NDJSON) or `docker compose ps
 * --format json` (NDJSON on older versions, one JSON array on newer).
 *
 * Unparseable lines are skipped rather than failing the whole listing: docker
 * occasionally prefixes output with a warning line, and one warning should not
 * blank the panel.
 */
export function parseContainers(out: string): Container[] {
  const rows: unknown[] = [];
  const trimmed = out.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) rows.push(...parsed);
    } catch {
      return [];
    }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        // Not a record — a warning or a partial write. Skip it.
      }
    }
  }

  const containers: Container[] = [];
  for (const row of rows) {
    const c = toContainer(row);
    if (c) containers.push(c);
  }
  return containers;
}

/** Docker's JSON keys differ between `docker ps` and `docker compose ps`
 *  (`Names` vs `Name`, `State` present only on the latter), so read both. */
function toContainer(row: unknown): Container | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const str = (k: string): string => (typeof r[k] === 'string' ? (r[k] as string) : '');

  const id = str('ID') || str('Id') || str('ContainerID');
  const name = str('Names') || str('Name') || str('Service');
  if (!id && !name) return null;

  const status = str('Status') || str('State');
  return {
    id,
    name,
    image: str('Image'),
    status,
    ports: str('Ports') || str('Publishers'),
    project: str('Project') || undefined,
    service: str('Service') || undefined,
    running: isRunning(str('State'), status),
  };
}

/**
 * Whether a container is up. `docker compose ps` gives a clean `State` field
 * (`running`, `exited`, `paused`); plain `docker ps` gives only the human
 * `Status` string, which starts with `Up` exactly when it is running.
 *
 * "Up 3 minutes (Paused)" is deliberately not running — the stop button on a
 * paused container is the useful affordance, not start.
 */
export function isRunning(state: string, status: string): boolean {
  if (state) {
    const s = state.toLowerCase();
    if (s === 'running') return true;
    if (s === 'paused' || s === 'exited' || s === 'created' || s === 'dead') return false;
  }
  if (/\(paused\)/i.test(status)) return false;
  return /^up\b/i.test(status.trim());
}

/** `docker ps -a` — every container, running or not, newest first. */
export function listCommand(): { program: string; args: string[] } {
  return { program: 'docker', args: ['ps', '-a', '--format', '{{json .}}'] };
}

/** The command for a container action. `id` comes from a listing we produced,
 *  never from user text, but it is still passed as its own argv entry rather
 *  than interpolated. */
export function actionCommand(
  action: ContainerAction,
  id: string,
): { program: string; args: string[] } {
  // `rm -f` because removing a running container otherwise errors, and the
  // panel already confirms destructive removal with the user.
  const args = action === 'rm' ? ['rm', '-f', id] : [action, id];
  return { program: 'docker', args };
}

/** Shell line that follows a container's logs, for a terminal tab. */
export function logsCommand(id: string): string {
  return `docker logs -f --tail 200 ${id}`;
}

/** Shell line for a compose lifecycle verb, run in the directory holding the
 *  compose file. */
export function composeCommand(verb: 'up' | 'down' | 'build'): string {
  return verb === 'up' ? 'docker compose up' : `docker compose ${verb}`;
}

/** Compose files ARC recognises at the workspace root. */
export const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

/** The compose file present at the root, if any. */
export function findComposeFile(rootEntries: string[]): string | null {
  return COMPOSE_FILES.find((f) => rootEntries.includes(f)) ?? null;
}

/** Group containers by compose project; loose containers land under `''`.
 *  Projects come first, in first-seen order, so a repo's own stack is on top. */
export function groupByProject(containers: Container[]): Array<[string, Container[]]> {
  const groups = new Map<string, Container[]>();
  for (const c of containers) {
    const key = c.project ?? '';
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === b) return 0;
    if (a === '') return 1;
    if (b === '') return -1;
    return 0;
  });
}
