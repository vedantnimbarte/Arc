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
      { name: 'listPets', method: 'GET', url: 'https://api.pets.test/v1/pets', body: null },
      {
        name: 'Create a pet',
        method: 'POST',
        url: 'https://api.pets.test/v1/pets',
        body: JSON.stringify({ name: 'Rex' }, null, 2),
      },
      {
        name: 'PUT /pets/{petId}',
        method: 'PUT',
        url: 'https://api.pets.test/v1/pets/{{petId}}',
        body: JSON.stringify({ name: 'Rex', age: 3 }, null, 2),
      },
      {
        name: 'DELETE /pets/{petId}',
        method: 'DELETE',
        url: 'https://api.pets.test/v1/pets/{{petId}}',
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

  it('rejects YAML and Swagger 2.0', () => {
    expect(() => parseOpenApi('openapi: 3.0.0')).toThrow(/JSON/);
    expect(() => parseOpenApi(JSON.stringify({ swagger: '2.0' }))).toThrow(/OpenAPI 3/);
  });
});
