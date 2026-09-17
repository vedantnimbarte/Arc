import { describe, expect, it } from 'vitest';
import { extractVariables, type PostVarRule } from '../responseVars';

const rule = (variable: string, source: PostVarRule['source'], path = '', enabled = true): PostVarRule => ({
  id: variable,
  enabled,
  variable,
  source,
  path,
});

describe('extractVariables', () => {
  const resp = {
    status: 201,
    headers: [{ name: 'X-Request-Id', value: 'r-1' }],
    body_text: JSON.stringify({ data: { accessToken: 'tok', user: { id: 7 } } }),
  };

  it('reads JSON paths, headers and the status', () => {
    expect(
      extractVariables(
        [
          rule('token', 'json', '$.data.accessToken'),
          rule('user', 'json', '$.data.user'),
          rule('rid', 'header', 'x-request-id'),
          rule('code', 'status'),
          rule('skipped', 'status', '', false),
          rule(' ', 'status'),
        ],
        resp,
      ),
    ).toEqual([
      { variable: 'token', value: 'tok' },
      { variable: 'user', value: '{"id":7}' },
      { variable: 'rid', value: 'r-1' },
      { variable: 'code', value: '201' },
    ]);
  });

  it('reports what it could not find', () => {
    expect(
      extractVariables(
        [rule('a', 'json', '$.nope'), rule('b', 'header', 'Etag'), rule('c', 'json', 'bad')],
        resp,
      ),
    ).toEqual([
      { variable: 'a', error: 'nothing at $.nope' },
      { variable: 'b', error: 'no Etag header' },
      { variable: 'c', error: expect.stringContaining('$') },
    ]);
    expect(extractVariables([rule('a', 'json', '$.x')], { ...resp, body_text: '<html>' })).toEqual([
      { variable: 'a', error: 'response is not JSON' },
    ]);
  });
});
