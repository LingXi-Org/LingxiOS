import { Ajv, type ValidateFunction } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import formatsPlugin from 'ajv-formats'
import type { ModelItem, CodeExecutionMode } from '../protocol/types.js'
import type { ToolDefinition } from '../tools/catalog.js'
import { parseTaskArgs } from '../tools/catalog.js'
import { parseIPythonArguments } from './tool.js'

// Compile trusted schemas only. No coercion, defaults, property deletion, remote
// loading or execution hooks. Business parsing and authorization still run later.
const options={strictSchema:true,strictTypes:false,strictTuples:false,allowUnionTypes:true,
  coerceTypes:false,useDefaults:false,removeAdditional:false,ownProperties:true,logger:false as const}
const draft7=new Ajv(options),draft2020=new Ajv2020(options)
// The package's CommonJS entry exposes the documented plugin as .default.
formatsPlugin.default(draft7);formatsPlugin.default(draft2020)
const cache = new WeakMap<ToolDefinition['parameters'],ValidateFunction>()
export function compileToolSchemas(tools:readonly ToolDefinition[]){
  for(const tool of tools)if(!cache.has(tool.parameters)){
    const dialect=Reflect.get(tool.parameters,'$schema')
    if(dialect!==undefined&&!['http://json-schema.org/draft-07/schema#','https://json-schema.org/draft-07/schema','https://json-schema.org/draft/2020-12/schema'].includes(String(dialect)))throw new Error('unsupported trusted tool schema dialect')
    const ajv=dialect==='https://json-schema.org/draft/2020-12/schema'?draft2020:draft7
    const validate=ajv.compile(tool.parameters)
    // Context snapshots are short-lived; do not retain every schema object in Ajv.
    ajv.removeSchema(tool.parameters)
    cache.set(tool.parameters,validate)
  }
}
export function validateToolBatch(calls:readonly Extract<ModelItem,{type:'function_call'}>[],tools:readonly ToolDefinition[],codeExecution:CodeExecutionMode,parallelTools?:boolean){
  compileToolSchemas(tools)
  const ids=new Set<string>()
  if(parallelTools===false&&calls.length>1)throw new Error('multiple calls violate the declared provider capability')
  for(const call of calls){
    if(!call.callId||ids.has(call.callId)||call.callId.length>256)throw new Error('tool call identity is missing or duplicated')
    ids.add(call.callId)
    if(call.name==='ipython'){
      if(codeExecution==='disabled')throw new Error('Python is not available for this request')
      parseIPythonArguments(call.arguments)
      continue
    }
    const tool=tools.find(tool=>tool.name===call.name)
    if(!tool)throw new Error('tool is not in the exposed catalog')
    const args:unknown=JSON.parse(call.arguments)
    if(!cache.get(tool.parameters)!(args))throw new Error('tool arguments do not match the exposed schema')
    if(tool.action.startsWith('task.'))parseTaskArgs(tool.action,args as Record<string,unknown>)
  }
}
