import {JSONSchema4Type, JSONSchema4TypeName} from 'json-schema'
import {findKey, includes, isPlainObject, map} from 'lodash'
import {format} from 'util'
import {Options} from './'
import {typeOfSchema} from './typeOfSchema'
import {
  AST,
  hasStandaloneName,
  T_ANY,
  T_ANY_ADDITIONAL_PROPERTIES,
  TInterface,
  TInterfaceParam,
  TNamedInterface,
  TTuple
} from './types/AST'
import {
  JSONSchema,
  JSONSchemaWithDefinitions,
  JSONSchemaWithLinks,
  JSONSchemaLink,
  SchemaSchema
} from './types/JSONSchema'
import {generateName, toSafeString} from './utils'

export type Processed = Map<JSONSchema | JSONSchema4Type, AST>

export type UsedNames = Set<string>

export function parse(
  schema: JSONSchema | JSONSchema4Type,
  options: Options,
  rootSchema = schema as JSONSchema,
  keyName?: string,
  isSchema = true,
  processed: Processed = new Map<JSONSchema | JSONSchema4Type, AST>(),
  usedNames = new Set<string>()
): AST {
  // If we've seen this node before, return it.
  if (processed.has(schema)) {
    return processed.get(schema)!
  }

  const definitions = getDefinitions(rootSchema)

  const keyNameFromDefinition = findKey(definitions, _ => _ === schema)

  // Cache processed ASTs before they are actually computed, then update
  // them in place using set(). This is to avoid cycles.
  // TODO: Investigate alternative approaches (lazy-computing nodes, etc.)
  const ast = {} as AST
  processed.set(schema, ast)
  const set = (_ast: AST) => Object.assign(ast, _ast)

  return isSchema
    ? parseNonLiteral(
        schema as SchemaSchema,
        options,
        rootSchema,
        keyName,
        keyNameFromDefinition,
        set,
        processed,
        usedNames
      )
    : parseLiteral(schema, keyName, keyNameFromDefinition, set)
}

function parseLiteral(
  schema: JSONSchema4Type,
  keyName: string | undefined,
  keyNameFromDefinition: string | undefined,
  set: (ast: AST) => AST
) {
  return set({
    keyName,
    params: schema,
    standaloneName: keyNameFromDefinition,
    type: 'LITERAL'
  })
}

function parseNonLiteral(
  schema: JSONSchema,
  options: Options,
  rootSchema: JSONSchema,
  keyName: string | undefined,
  keyNameFromDefinition: string | undefined,
  set: (ast: AST) => AST,
  processed: Processed,
  usedNames: UsedNames
) {
  switch (typeOfSchema(schema)) {
    case 'ALL_OF':
      return set({
        comment: schema.description,
        keyName,
        params: schema.allOf!.map(_ => parse(_, options, rootSchema, undefined, true, processed, usedNames)),
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'INTERSECTION'
      })
    case 'ANY':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'ANY'
      })
    case 'ANY_OF':
      return set({
        comment: schema.description,
        keyName,
        params: schema.anyOf!.map(_ => parse(_, options, rootSchema, undefined, true, processed, usedNames)),
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'UNION'
      })
    case 'BOOLEAN':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'BOOLEAN'
      })
    case 'CUSTOM_TYPE':
      return set({
        comment: schema.description,
        keyName,
        params: schema.tsType!,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'CUSTOM_TYPE'
      })
    case 'NAMED_ENUM':
      return set({
        comment: schema.description,
        keyName,
        params: schema.enum!.map((_, n) => ({
          ast: parse(_, options, rootSchema, undefined, false, processed, usedNames),
          keyName: schema.tsEnumNames![n]
        })),
        standaloneName: standaloneName(schema, keyName, usedNames)!,
        type: 'ENUM'
      })
    case 'NAMED_SCHEMA':
      return set(newInterface(schema as SchemaSchema, options, rootSchema, processed, usedNames, keyName))
    case 'NULL':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'NULL'
      })
    case 'NUMBER':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'NUMBER'
      })
    case 'OBJECT':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'OBJECT'
      })
    case 'ONE_OF':
      return set({
        comment: schema.description,
        keyName,
        params: schema.oneOf!.map(_ => parse(_, options, rootSchema, undefined, true, processed, usedNames)),
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'UNION'
      })
    case 'REFERENCE':
      throw Error(format('Refs should have been resolved by the resolver!', schema))
    case 'STRING':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'STRING'
      })
    case 'CONST_STRING':
      return set({
        comment: schema.description,
        keyName,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        constValue: schema.pattern!.replace(/\^/, '').replace(/\$/, ''),
        type: 'CONST_STRING'
      })
    case 'TYPED_ARRAY':
      if (Array.isArray(schema.items)) {
        // normalised to not be undefined
        const minItems = schema.minItems!
        const maxItems = schema.maxItems!
        const arrayType: TTuple = {
          comment: schema.description,
          keyName,
          maxItems,
          minItems,
          params: schema.items.map(_ => parse(_, options, rootSchema, undefined, true, processed, usedNames)),
          standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
          type: 'TUPLE'
        }
        if (schema.additionalItems === true) {
          arrayType.spreadParam = {
            type: 'ANY'
          }
        } else if (schema.additionalItems) {
          arrayType.spreadParam = parse(
            schema.additionalItems,
            options,
            rootSchema,
            undefined,
            true,
            processed,
            usedNames
          )
        }
        return set(arrayType)
      } else {
        const params = parse(schema.items!, options, rootSchema, undefined, true, processed, usedNames)
        return set({
          comment: schema.description,
          keyName,
          params,
          standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
          type: 'ARRAY'
        })
      }
    case 'UNION':
      return set({
        comment: schema.description,
        keyName,
        params: (schema.type as JSONSchema4TypeName[]).map(_ =>
          parse({...schema, type: _}, options, rootSchema, undefined, true, processed, usedNames)
        ),
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'UNION'
      })
    case 'UNNAMED_ENUM':
      return set({
        comment: schema.description,
        keyName,
        params: schema.enum!.map(_ => parse(_, options, rootSchema, undefined, false, processed, usedNames)),
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'UNION'
      })
    case 'UNNAMED_SCHEMA':
      return set(
        newInterface(schema as SchemaSchema, options, rootSchema, processed, usedNames, keyName, keyNameFromDefinition)
      )
    case 'UNTYPED_ARRAY':
      // normalised to not be undefined
      const minItems = schema.minItems!
      const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : -1
      const params = T_ANY
      if (minItems > 0 || maxItems >= 0) {
        return set({
          comment: schema.description,
          keyName,
          maxItems: schema.maxItems,
          minItems,
          // create a tuple of length N
          params: Array(Math.max(maxItems, minItems) || 0).fill(params),
          // if there is no maximum, then add a spread item to collect the rest
          spreadParam: maxItems >= 0 ? undefined : params,
          standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
          type: 'TUPLE'
        })
      }

      return set({
        comment: schema.description,
        keyName,
        params,
        standaloneName: standaloneName(schema, keyNameFromDefinition, usedNames),
        type: 'ARRAY'
      })
  }
}

/**
 * Compute a schema name using a series of fallbacks
 */
function standaloneName(
  schema: JSONSchema,
  keyNameFromDefinition: string | undefined,
  usedNames: UsedNames
): string | undefined {
  const name = schema.id || keyNameFromDefinition || schema.title
  if (name) {
    return generateName(name, usedNames)
  }
}

function newInterface(
  schema: SchemaSchema,
  options: Options,
  rootSchema: JSONSchema,
  processed: Processed,
  usedNames: UsedNames,
  keyName?: string,
  keyNameFromDefinition?: string
): TInterface {
  const name = standaloneName(schema, keyNameFromDefinition, usedNames)!
  return {
    comment: schema.description,
    keyName,
    params: parseSchema(schema, options, rootSchema, processed, usedNames, name),
    standaloneName: name,
    superTypes: parseSuperTypes(schema, options, processed, usedNames),
    type: 'INTERFACE'
  }
}

function parseSuperTypes(
  schema: SchemaSchema,
  options: Options,
  processed: Processed,
  usedNames: UsedNames
): TNamedInterface[] {
  // Type assertion needed because of dereferencing step
  // TODO: Type it upstream
  const superTypes = schema.extends as SchemaSchema | SchemaSchema[] | undefined
  if (!superTypes) {
    return []
  }
  if (Array.isArray(superTypes)) {
    return superTypes.map(_ => newNamedInterface(_, options, _, processed, usedNames))
  }
  return [newNamedInterface(superTypes, options, superTypes, processed, usedNames)]
}

function newNamedInterface(
  schema: SchemaSchema,
  options: Options,
  rootSchema: JSONSchema,
  processed: Processed,
  usedNames: UsedNames
): TNamedInterface {
  const namedInterface = newInterface(schema, options, rootSchema, processed, usedNames)
  if (hasStandaloneName(namedInterface)) {
    return namedInterface
  }
  // TODO: Generate name if it doesn't have one
  throw Error(format('Supertype must have standalone name!', namedInterface))
}

/**
 * Helper to parse schema properties into params on the parent schema's type
 */
function parseSchema(
  schema: SchemaSchema,
  options: Options,
  rootSchema: JSONSchema,
  processed: Processed,
  usedNames: UsedNames,
  parentSchemaName: string
): TInterfaceParam[] {
  let asts: TInterfaceParam[] = map(schema.properties, (value, key: string) => ({
    ast: parse(value, options, rootSchema, key, true, processed, usedNames),
    isPatternProperty: false,
    isRequired: includes(schema.required || [], key),
    isUnreachableDefinition: false,
    keyName: key
  }))

  let singlePatternProperty = false
  if (schema.patternProperties) {
    // partially support patternProperties. in the case that
    // additionalProperties is not set, and there is only a single
    // value definition, we can validate against that.
    singlePatternProperty = !schema.additionalProperties && Object.keys(schema.patternProperties).length === 1

    asts = asts.concat(
      map(schema.patternProperties, (value, key: string) => {
        const ast = parse(value, options, rootSchema, key, true, processed, usedNames)
        const comment = `This interface was referenced by \`${parentSchemaName}\`'s JSON-Schema definition
via the \`patternProperty\` "${key}".`
        ast.comment = ast.comment ? `${ast.comment}\n\n${comment}` : comment
        return {
          ast,
          isPatternProperty: !singlePatternProperty,
          isRequired: singlePatternProperty || includes(schema.required || [], key),
          isUnreachableDefinition: false,
          keyName: singlePatternProperty ? '[k: string]' : key
        }
      })
    )
  }

  if (options.unreachableDefinitions) {
    asts = asts.concat(
      map(schema.definitions, (value, key: string) => {
        const ast = parse(value, options, rootSchema, key, true, processed, usedNames)
        const comment = `This interface was referenced by \`${parentSchemaName}\`'s JSON-Schema
via the \`definition\` "${key}".`
        ast.comment = ast.comment ? `${ast.comment}\n\n${comment}` : comment
        return {
          ast,
          isPatternProperty: false,
          isRequired: includes(schema.required || [], key),
          isUnreachableDefinition: true,
          keyName: key
        }
      })
    )

    if (hasLinks(schema)) {
      asts = asts.concat(
        schema.links
          .map(link => {
            const result = []

            if (link.schema) {
              result.push(
                linkAst(link.schema, link.rel, 'schema', options, rootSchema, processed, usedNames, parentSchemaName)
              )
            }

            if (link.targetSchema) {
              result.push(
                linkAst(
                  link.targetSchema,
                  link.rel,
                  'targetSchema',
                  options,
                  rootSchema,
                  processed,
                  usedNames,
                  parentSchemaName
                )
              )
            }

            if (link.jobSchema) {
              result.push(
                linkAst(
                  link.jobSchema,
                  link.rel,
                  'jobSchema',
                  options,
                  rootSchema,
                  processed,
                  usedNames,
                  parentSchemaName
                )
              )
            }

            if (link.hrefSchema) {
              result.push(
                linkAst(
                  link.hrefSchema,
                  link.rel,
                  'hrefSchema',
                  options,
                  rootSchema,
                  processed,
                  usedNames,
                  parentSchemaName
                )
              )
            }

            return result
          })
          .flat(1)
      )
    }
  }

  // handle additionalProperties
  switch (schema.additionalProperties) {
    case undefined:
    case true:
      if (singlePatternProperty) {
        return asts
      }
      return asts.concat({
        ast: T_ANY_ADDITIONAL_PROPERTIES,
        isPatternProperty: false,
        isRequired: true,
        isUnreachableDefinition: false,
        keyName: '[k: string]'
      })

    case false:
      return asts

    // pass "true" as the last param because in TS, properties
    // defined via index signatures are already optional
    default:
      return asts.concat({
        ast: parse(schema.additionalProperties, options, rootSchema, '[k: string]', true, processed, usedNames),
        isPatternProperty: false,
        isRequired: true,
        isUnreachableDefinition: false,
        keyName: '[k: string]'
      })
  }
}

function linkAst(
  schema: JSONSchema,
  linkRel: string,
  name: string,
  options: Options,
  rootSchema: JSONSchema,
  processed: Processed,
  usedNames: UsedNames,
  parentSchemaName: string
) {
  const ast = parse(schema, options, rootSchema, name, true, processed, usedNames)
  const comment = `This interface was referenced by \`${parentSchemaName}\`'s JSON-Schema
via the \`${linkRel}.${name}\` link.`
  ast.comment = ast.comment ? `${ast.comment}\n\n${comment}` : comment
  ast.aliases = [...(ast.aliases || []), toSafeString(`${parentSchemaName}_${linkRel}_${name}`)]

  return {
    ast,
    isPatternProperty: false,
    isRequired: false,
    isUnreachableDefinition: true,
    keyName: name
  }
}

type Definitions = {[k: string]: JSONSchema}

/**
 * TODO: Memoize
 */
function getDefinitions(
  schema: JSONSchema,
  isSchema = true,
  processed = new Set<JSONSchema>(),
  prefix: string = ''
): Definitions {
  if (processed.has(schema)) {
    return {}
  }
  processed.add(schema)
  if (Array.isArray(schema)) {
    return schema.reduce(
      (prev, cur) => ({
        ...prev,
        ...getDefinitions(cur, false, processed)
      }),
      {}
    )
  }

  const realPrefix = prefix === 'properties_' ? '' : prefix

  if (isPlainObject(schema)) {
    return {
      ...(isSchema && hasDefinitions(schema)
        ? Object.fromEntries(
            Object.entries(schema.definitions).map(([key, value]) => {
              return [`${realPrefix}${key}`, value]
            })
          )
        : {}),
      ...Object.keys(schema).reduce<Definitions>((prev, cur) => {
        if (schema.$schema && cur === 'links') {
          return prev
        }
        return {
          ...prev,
          ...getDefinitions(schema[cur], true, processed, `${realPrefix}${cur}_`)
        }
      }, {}),
      ...(isSchema && hasLinks(schema)
        ? schema.links.reduce<Definitions>(
            (prev, link) => ({...prev, ...findDefinitionsWithinLink(link, realPrefix)}),
            {}
          )
        : {})
    }
  }
  return {}
}

function findDefinitionsWithinLink(link: JSONSchemaLink, prefix: string): Definitions {
  const definitions: Definitions = {}

  if (link.schema) {
    definitions[prefix + link.rel + '_schema'] = link.schema
  }

  if (link.targetSchema) {
    definitions[prefix + link.rel + '_target_schema'] = link.targetSchema
  }

  if (link.jobSchema) {
    definitions[prefix + link.rel + '_job_schema'] = link.jobSchema
  }

  if (link.hrefSchema) {
    definitions[prefix + link.rel + '_href_schema'] = link.hrefSchema
  }

  return definitions
}

/**
 * TODO: Reduce rate of false positives
 */
function hasDefinitions(schema: JSONSchema): schema is JSONSchemaWithDefinitions {
  return 'definitions' in schema
}

function hasLinks(schema: JSONSchema): schema is JSONSchemaWithLinks {
  return 'links' in schema
}
