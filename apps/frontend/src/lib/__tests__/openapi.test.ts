import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../openapi';

const spec = {
  openapi: '3.0.3',
  info: { title: 'Pet Store' },
  servers: [{ url: 'https://{env}.pets.test/v1/', variables: { env: { default: 'api' } } }],
  paths: {
    '/pets': {
      get: { operationId: 'listPets' },
      post: {
        summary: 'Create a pet',
        requestBody: { $ref: '#/components/requestBodies/NewPet' },
      },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path' }],
      put: {
        requestBody: {
          content: {
            'application/json': { examples: { one: { $ref: '#/components/examples/Rex' } } },
          },
        },
      },
      delete: {},
    },
  },
  components: {
    requestBodies: {
      NewPet: {
        content: { 'application/json': { schema: { example: { name: 'Rex' } } } },
      },
    },
    examples: { Rex: { value: { name: 'Rex', age: 3 } } },
  },
};

describe('parseOpenApi', () => {
  it('creates one request per path+method', () => {
    const r = parseOpenApi(JSON.stringify(spec));
    expect(r.name).toBe('Pet Store');
    expect(r.requests).toEqual([
      {
        name: 'listPets',
        method: 'GET',
        url: 'https://api.pets.test/v1/pets',
        params: [],
        headers: [],
        body: null,
      },
      {
        name: 'Create a pet',
        method: 'POST',
        url: 'https://api.pets.test/v1/pets',
        params: [],
        headers: [],
        body: JSON.stringify({ name: 'Rex' }, null, 2),
      },
      {
        name: 'PUT /pets/{petId}',
        method: 'PUT',
        url: 'https://api.pets.test/v1/pets/{{petId}}',
        params: [],
        headers: [],
        body: JSON.stringify({ name: 'Rex', age: 3 }, null, 2),
      },
      {
        name: 'DELETE /pets/{petId}',
        method: 'DELETE',
        url: 'https://api.pets.test/v1/pets/{{petId}}',
        params: [],
        headers: [],
        body: null,
      },
    ]);
  });

  it('prefers an inline example and works without servers', () => {
    const r = parseOpenApi(
      JSON.stringify({
        openapi: '3.1.0',
        info: {},
        paths: {
          '/x': {
            post: {
              requestBody: { content: { 'application/json': { example: [1, 2] } } },
            },
          },
        },
      }),
    );
    expect(r.name).toBe('Imported API');
    expect(r.requests[0]).toMatchObject({ url: '/x', body: JSON.stringify([1, 2], null, 2) });
  });

  it('rejects Swagger 2.0 and unparseable input', () => {
    expect(() => parseOpenApi(JSON.stringify({ swagger: '2.0' }))).toThrow(/OpenAPI 3/);
    expect(() => parseOpenApi('swagger: "2.0"')).toThrow(/OpenAPI 3/);
    expect(() => parseOpenApi('openapi: [3')).toThrow(/JSON or YAML/);
  });

  it('reads YAML, and imports query and header parameters', () => {
    const r = parseOpenApi(`
openapi: 3.1
info:
  title: Search
servers:
  - url: https://api.test
paths:
  /search:
    parameters:
      - name: limit
        in: query
        schema: { type: integer, default: 20 }
      - $ref: '#/components/parameters/Trace'
    get:
      summary: Search things
      parameters:
        - name: q
          in: query
          example: shoes
        - name: limit
          in: query
          schema: { example: 5 }
        - name: filter
          in: query
          examples:
            one: { value: { color: red } }
        - name: X-Api-Version
          in: header
          required: true
        - name: session
          in: cookie
          example: abc
components:
  parameters:
    Trace:
      name: X-Trace
      in: header
      schema: { default: on }
`);
    expect(r.name).toBe('Search');
    expect(r.requests).toEqual([
      {
        name: 'Search things',
        method: 'GET',
        url: 'https://api.test/search',
        // The operation's `limit` overrides the path-level one in place;
        // cookie parameters are skipped.
        params: [
          { name: 'limit', value: '5' },
          { name: 'q', value: 'shoes' },
          { name: 'filter', value: '{"color":"red"}' },
        ],
        headers: [
          { name: 'X-Trace', value: 'on' },
          { name: 'X-Api-Version', value: '' },
        ],
        body: null,
      },
    ]);
  });
});
