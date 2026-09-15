/**
 * OpenAPI 3.x → API Client collection. Pure; JSON documents only (there is
 * no YAML parser in the dependency tree).
 */

export interface ImportedRequest {
  name: string;
  method: string;
  url: string;
  /** Pretty-printed JSON example body, when the spec provides one. */
  body: string | null;
}

export interface OpenApiImport {
  name: string;
  requests: ImportedRequest[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Follow local `#/…` $refs. Remote refs are left unresolved. */
function deref(doc: Obj, v: unknown): Obj | undefined {
  let cur = v;
  for (let depth = 0; depth < 16 && isObj(cur) && typeof cur.$ref === 'string'; depth++) {
    const ref = cur.$ref;
    if (!ref.startsWith('#/')) return undefined;
    cur = ref
      .slice(2)
      .split('/')
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<unknown>((node, key) => (isObj(node) ? node[key] : undefined), doc);
  }
  return isObj(cur) ? cur : undefined;
}

function exampleBody(doc: Obj, op: Obj): string | null {
  const content = deref(doc, op.requestBody)?.content;
  if (!isObj(content)) return null;
  const key = 'application/json' in content ? 'application/json' : Object.keys(content).find((k) => k.includes('json'));
  const media = key ? deref(doc, content[key]) : undefined;
  if (!media) return null;
  let example: unknown = media.example;
  if (example === undefined && isObj(media.examples)) {
    const firstExample = Object.values(media.examples)[0];
    example = deref(doc, firstExample)?.value;
  }
  if (example === undefined) example = deref(doc, media.schema)?.example;
  return example === undefined ? null : JSON.stringify(example, null, 2);
}

function baseUrl(doc: Obj): string {
  const server = Array.isArray(doc.servers) && isObj(doc.servers[0]) ? doc.servers[0] : undefined;
  if (!server || typeof server.url !== 'string') return '';
  const vars = isObj(server.variables) ? server.variables : {};
  return server.url
    .replace(/\{([^}]+)\}/g, (m, name: string) => {
      const v = vars[name];
      return isObj(v) && v.default !== undefined ? String(v.default) : m;
    })
    .replace(/\/+$/, '');
}

export function parseOpenApi(text: string): OpenApiImport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON — only JSON OpenAPI documents are supported');
  }
  if (!isObj(doc) || typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3')) {
    throw new Error('Not an OpenAPI 3.x document');
  }
  const base = baseUrl(doc);
  const info = isObj(doc.info) ? doc.info : {};
  const requests: ImportedRequest[] = [];
  for (const [path, rawItem] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    const item = deref(doc, rawItem);
    if (!item) continue;
    for (const m of METHODS) {
      const op = item[m];
      if (!isObj(op)) continue;
      const method = m.toUpperCase();
      requests.push({
        name:
          (typeof op.summary === 'string' && op.summary) ||
          (typeof op.operationId === 'string' && op.operationId) ||
          `${method} ${path}`,
        method,
        // Path params become {{name}} so an environment can fill them.
        url: base + path.replace(/\{([^}]+)\}/g, '{{$1}}'),
        body: exampleBody(doc, op),
      });
    }
  }
  return { name: typeof info.title === 'string' && info.title ? info.title : 'Imported API', requests };
}
