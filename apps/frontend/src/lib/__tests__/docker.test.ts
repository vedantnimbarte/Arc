import { describe, expect, it } from 'vitest';
import {
  actionCommand,
  findComposeFile,
  groupByProject,
  isRunning,
  logsCommand,
  parseContainers,
} from '../docker';

const psLine = (o: Record<string, string>) => JSON.stringify(o);

describe('parseContainers', () => {
  it('reads NDJSON from docker ps', () => {
    const out = [
      psLine({
        ID: 'abc123',
        Names: 'web',
        Image: 'nginx:latest',
        Status: 'Up 4 minutes',
        Ports: '0.0.0.0:8080->80/tcp',
      }),
      psLine({ ID: 'def456', Names: 'db', Image: 'postgres:16', Status: 'Exited (0) 1 hour ago' }),
    ].join('\n');
    const containers = parseContainers(out);
    expect(containers).toHaveLength(2);
    expect(containers[0]).toMatchObject({
      id: 'abc123',
      name: 'web',
      image: 'nginx:latest',
      running: true,
      ports: '0.0.0.0:8080->80/tcp',
    });
    expect(containers[1]!.running).toBe(false);
  });

  it('reads the single-array form newer docker compose emits', () => {
    const out = JSON.stringify([
      { ID: 'a1', Name: 'stack-api-1', Service: 'api', Project: 'stack', State: 'running' },
      { ID: 'b2', Name: 'stack-db-1', Service: 'db', Project: 'stack', State: 'exited' },
    ]);
    const containers = parseContainers(out);
    expect(containers.map((c) => c.running)).toEqual([true, false]);
    expect(containers[0]!.project).toBe('stack');
    expect(containers[0]!.service).toBe('api');
  });

  it('skips warning lines instead of blanking the listing', () => {
    const out = ['WARNING: buildx is deprecated', psLine({ ID: 'a', Names: 'x', Status: 'Up 1s' })].join(
      '\n',
    );
    expect(parseContainers(out)).toHaveLength(1);
  });

  it('returns nothing for empty output', () => {
    expect(parseContainers('')).toEqual([]);
    expect(parseContainers('   \n  ')).toEqual([]);
  });

  it('drops records with neither an id nor a name', () => {
    expect(parseContainers(psLine({ Image: 'nginx' }))).toEqual([]);
  });
});

describe('isRunning', () => {
  it('trusts the compose State field when present', () => {
    expect(isRunning('running', '')).toBe(true);
    expect(isRunning('exited', '')).toBe(false);
    expect(isRunning('created', '')).toBe(false);
  });

  it('falls back to the Up prefix of docker ps status text', () => {
    expect(isRunning('', 'Up 4 minutes')).toBe(true);
    expect(isRunning('', 'Exited (137) 3 minutes ago')).toBe(false);
    expect(isRunning('', 'Restarting (1) 2 seconds ago')).toBe(false);
  });

  it('treats a paused container as not running, despite the Up prefix', () => {
    // Otherwise the row offers "stop" on something already halted.
    expect(isRunning('', 'Up 3 minutes (Paused)')).toBe(false);
    expect(isRunning('paused', 'Up 3 minutes (Paused)')).toBe(false);
  });
});

describe('actionCommand', () => {
  it('passes the id as its own argv entry', () => {
    expect(actionCommand('stop', 'abc123')).toEqual({ program: 'docker', args: ['stop', 'abc123'] });
    expect(actionCommand('restart', 'abc')).toEqual({
      program: 'docker',
      args: ['restart', 'abc'],
    });
  });

  it('forces removal, since rm on a running container errors', () => {
    expect(actionCommand('rm', 'abc')).toEqual({ program: 'docker', args: ['rm', '-f', 'abc'] });
  });
});

describe('logsCommand / findComposeFile', () => {
  it('follows logs with a bounded backlog', () => {
    expect(logsCommand('abc')).toBe('docker logs -f --tail 200 abc');
  });

  it('finds a compose file at the root, preferring the canonical name', () => {
    expect(findComposeFile(['README.md', 'docker-compose.yml'])).toBe('docker-compose.yml');
    expect(findComposeFile(['compose.yaml'])).toBe('compose.yaml');
    expect(findComposeFile(['package.json'])).toBeNull();
  });
});

describe('groupByProject', () => {
  it('puts compose projects above loose containers', () => {
    const containers = parseContainers(
      [
        psLine({ ID: '1', Names: 'loose', Status: 'Up 1s' }),
        psLine({ ID: '2', Names: 'stack-api-1', Project: 'stack', State: 'running' }),
        psLine({ ID: '3', Names: 'stack-db-1', Project: 'stack', State: 'running' }),
      ].join('\n'),
    );
    const groups = groupByProject(containers);
    expect(groups.map(([name, list]) => [name, list.length])).toEqual([
      ['stack', 2],
      ['', 1],
    ]);
  });
});
