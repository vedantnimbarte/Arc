import { describe, expect, it } from 'vitest';
import { buildRelations } from '../dbRelations';
import type { DbTableSchema } from '../tauri';

function schema(partial: Partial<DbTableSchema>): DbTableSchema {
  return { columns: [], indexes: [], foreign_keys: [], checks: [], ...partial };
}

function col(name: string, primary_key = false) {
  return { name, data_type: 'text', nullable: !primary_key, default: null, primary_key };
}

describe('buildRelations', () => {
  it('classifies a plain foreign key as 1:N', () => {
    const schemas = {
      users: schema({ columns: [col('id', true)] }),
      posts: schema({
        columns: [col('id', true), col('user_id')],
        foreign_keys: [{ name: 'fk_user', columns: 'user_id', references: 'users(id)' }],
      }),
    };
    const { relations } = buildRelations(schemas);
    expect(relations).toEqual([
      { from: 'posts', fromColumns: ['user_id'], to: 'users', toColumns: ['id'], kind: '1:N' },
    ]);
  });

  it('classifies a 1:1 through the child primary key', () => {
    const schemas = {
      users: schema({ columns: [col('id', true)] }),
      profiles: schema({
        columns: [col('user_id', true)],
        foreign_keys: [{ name: '', columns: 'user_id', references: 'users(id)' }],
      }),
    };
    const { relations } = buildRelations(schemas);
    expect(relations[0]!.kind).toBe('1:1');
  });

  it('classifies a 1:1 through a unique index', () => {
    const schemas = {
      users: schema({ columns: [col('id', true)] }),
      profiles: schema({
        columns: [col('id', true), col('user_id')],
        indexes: [{ name: 'ux_user', columns: 'user_id', unique: true, primary: false, implicit: false, definition: null }],
        foreign_keys: [{ name: '', columns: 'user_id', references: 'users(id)' }],
      }),
    };
    const { relations } = buildRelations(schemas);
    expect(relations[0]!.kind).toBe('1:1');
  });

  it('recognizes a junction table by composite primary key as M:N', () => {
    const schemas = {
      posts: schema({ columns: [col('id', true)] }),
      tags: schema({ columns: [col('id', true)] }),
      post_tags: schema({
        columns: [col('post_id', true), col('tag_id', true)],
        foreign_keys: [
          { name: '', columns: 'post_id', references: 'posts(id)' },
          { name: '', columns: 'tag_id', references: 'tags(id)' },
        ],
      }),
    };
    const { relations, junctions } = buildRelations(schemas);
    expect(relations.every((r) => r.kind === 'M:N')).toBe(true);
    expect(relations.every((r) => r.viaJunction === 'post_tags')).toBe(true);
    expect(junctions.post_tags!.sort()).toEqual(['posts', 'tags']);
  });

  it('recognizes a junction with a surrogate id plus a unique pair as M:N', () => {
    const schemas = {
      posts: schema({ columns: [col('id', true)] }),
      tags: schema({ columns: [col('id', true)] }),
      post_tags: schema({
        columns: [col('id', true), col('post_id'), col('tag_id')],
        indexes: [{ name: 'ux_pair', columns: 'post_id, tag_id', unique: true, primary: false, implicit: false, definition: null }],
        foreign_keys: [
          { name: '', columns: 'post_id', references: 'posts(id)' },
          { name: '', columns: 'tag_id', references: 'tags(id)' },
        ],
      }),
    };
    const { junctions } = buildRelations(schemas);
    expect(junctions.post_tags).toBeDefined();
  });

  it('resolves an implicit SQLite reference to the parent primary key', () => {
    const schemas = {
      users: schema({ columns: [col('id', true)] }),
      posts: schema({
        columns: [col('id', true), col('user_id')],
        foreign_keys: [{ name: '', columns: 'user_id', references: 'users' }],
      }),
    };
    const { relations } = buildRelations(schemas);
    expect(relations[0]!.toColumns).toEqual(['id']);
  });

  it('resolves a Postgres reference without the schema prefix', () => {
    const schemas = {
      'public.users': schema({ columns: [col('id', true)] }),
      'public.posts': schema({
        columns: [col('id', true), col('user_id')],
        foreign_keys: [{ name: 'fk_user', columns: 'user_id', references: 'users(id)' }],
      }),
    };
    const { relations } = buildRelations(schemas);
    expect(relations[0]!.to).toBe('public.users');
  });

  it('drops a reference that cannot be resolved', () => {
    const schemas = {
      posts: schema({
        columns: [col('id', true), col('user_id')],
        foreign_keys: [{ name: '', columns: 'user_id', references: 'ghost(id)' }],
      }),
    };
    const { relations } = buildRelations(schemas);
    expect(relations).toEqual([]);
  });
});
