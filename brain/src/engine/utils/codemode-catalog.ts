import { rankToolsByQuery } from '@okidoki/shared';
import { isRecord } from './type-guards';

export interface CatalogTool {
  namespace: string;
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

const DESCRIPTION_LIMIT_CHARS = 1_200;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function typeOf(root: unknown, docs: boolean): string {
  const resolve = (schema: unknown, seen: string[]): unknown => {
    if (!isRecord(schema)) return schema;
    if (typeof schema.$ref === 'string') {
      if (seen.includes(schema.$ref) || !schema.$ref.startsWith('#/')) return undefined;
      seen.push(schema.$ref);
      return resolve(schema.$ref.slice(2).split('/').reduce<unknown>((node, key) => (isRecord(node) ? node[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), root), seen);
    }
    if (!Array.isArray(schema.allOf)) return schema;
    const { allOf, ...own } = schema;
    const parts = [...allOf.map((part) => resolve(part, seen)), own].filter(isRecord);
    return {
      ...Object.assign({}, ...parts),
      properties: Object.assign({}, ...parts.map((part) => part.properties)),
      required: parts.flatMap((part) => (Array.isArray(part.required) ? part.required : [])),
    };
  };
  // `refs` holds the references open on the way down, so a schema that contains itself ends in `unknown`.
  const render = (unresolved: unknown, indent: string, refs: string[]): string => {
    const seen = [...refs];
    const schema = resolve(unresolved, seen);
    if (!isRecord(schema)) return 'unknown';
    if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
    if (schema.const !== undefined) return JSON.stringify(schema.const);
    const union = [schema.anyOf, schema.oneOf].find(Array.isArray);
    if (union) return [...new Set(union.map((member) => render(member, indent, seen)))].join(' | ');
    if (Array.isArray(schema.type)) return schema.type.map((type) => render({ ...schema, type }, indent, seen)).join(' | ');
    if (schema.type === 'array') {
      const item = render(schema.items, indent, seen);
      return item.includes(' | ') ? `(${item})[]` : `${item}[]`;
    }
    if (schema.type === 'object' || isRecord(schema.properties)) {
      const properties = isRecord(schema.properties) ? Object.entries(schema.properties) : [];
      if (properties.length === 0) return isRecord(schema.additionalProperties) ? `Record<string, ${render(schema.additionalProperties, indent, seen)}>` : 'object';
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const fields = properties.map(([key, value]) => {
        const field = `${IDENTIFIER.test(key) ? key : JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${render(value, `${indent}  `, seen)}`;
        const note = docs && isRecord(value) && typeof value.description === 'string' ? ` // ${value.description.replace(/\s+/g, ' ')}` : '';
        return docs ? `${indent}  ${field};${note}` : field;
      });
      return docs ? `{\n${fields.join('\n')}\n${indent}}` : `{ ${fields.join(', ')} }`;
    }
    if (schema.type === 'integer' || schema.type === 'number') return typeof schema.maximum === 'number' ? `number /* max ${schema.maximum} */` : 'number';
    return typeof schema.type === 'string' ? schema.type : 'unknown';
  };
  return render(root, '', []);
}

function callExpression(tool: CatalogTool, docs: boolean): string {
  const input = typeOf(tool.inputSchema, docs);
  return `${IDENTIFIER.test(tool.name) ? tool.name : `[${JSON.stringify(tool.name)}]`}(${input === 'object' ? '' : input})`;
}

export function toolSignature(tool: CatalogTool, docs: boolean): string {
  const expression = callExpression(tool, docs);
  const signature = `tools.${tool.namespace}${expression.startsWith('[') ? '' : '.'}${expression}: Promise<${typeOf(tool.outputSchema, docs)}>`;
  if (!docs || !tool.description) return signature;
  const description = tool.description.length > DESCRIPTION_LIMIT_CHARS ? `${tool.description.slice(0, DESCRIPTION_LIMIT_CHARS)}...` : tool.description;
  return `/** ${description.trim()} */\n${signature}`;
}

export function searchTools(catalog: CatalogTool[], query: string, namespace?: string): CatalogTool[] {
  const scoped = namespace ? catalog.filter((tool) => tool.namespace === namespace) : catalog;
  return query.trim() ? rankToolsByQuery(scoped, query, (tool) => ({ name: `${tool.namespace}.${tool.name}`, description: tool.description })) : scoped;
}

export function renderCatalog(catalog: CatalogTool[], failed: string[], connecting: string[], budgetChars: number): string {
  const namespaces = [...Map.groupBy(catalog, (tool) => tool.namespace)];
  const render = (list: (tools: CatalogTool[]) => string) => namespaces
    .map(([namespace, tools]) => `tools.${namespace} (${tools.length} tool${tools.length === 1 ? '' : 's'})${list(tools)}`)
    .join('\n');
  const listing = [
    render((tools) => `:\n${tools.map((tool) => `  ${callExpression(tool, false)}`).join('\n')}`),
    render((tools) => `: ${tools.map((tool) => tool.name).join(', ')}`),
  ].find((candidate) => candidate.length <= budgetChars) ?? render(() => '');
  return [
    catalog.length ? `Tools:\n${listing}` : 'No MCP server is connected yet, so there are no tools to call.',
    // Servers finish connecting in a different order each start; sorted, the same states give the same text and the prompt cache holds.
    ...(connecting.length ? [`Still connecting, find their tools with \`search\`: ${connecting.toSorted().join(', ')}`] : []),
    ...(failed.length ? [`Failed to connect: ${failed.toSorted().join(', ')}`] : []),
  ].join('\n');
}
