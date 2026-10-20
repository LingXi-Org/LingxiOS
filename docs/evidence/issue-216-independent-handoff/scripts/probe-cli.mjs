import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'

export async function setup(needsExpectation=false){
 process.umask(0o077)
 const {values}=parseArgs({options:{
  'runtime-root':{type:'string'},
  'source-revision':{type:'string'},
  'output-dir':{type:'string'},
  ...(needsExpectation?{expect:{type:'string'}}:{}),
 },strict:true,allowPositionals:false})
 const root=values['runtime-root'],out=values['output-dir'],revision=values['source-revision']
 if(!root||!out||!path.isAbsolute(root)||!path.isAbsolute(out)||!/^[a-f0-9]{40}$/.test(revision??'')) throw Error('invalid_arguments')
 const rootPath=path.resolve(root),outputDir=path.resolve(out),relative=path.relative(rootPath,outputDir)
 if(relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative))) throw Error('output_inside_runtime')
 if(needsExpectation&&!['red','green'].includes(values.expect)) throw Error('invalid_expectation')
 // A new output directory prevents accidental replacement of historical evidence.
 await mkdir(outputDir,{mode:0o700})
 const files=[
  'package.json','db/schema.sql','dist/test/memory-fixture.js',
  'dist/src/app/index.js','dist/src/app/maintenance.js',
  'dist/src/runtime/runtime.js','dist/src/runtime/compaction.js',
  'dist/src/memory/history.js',
 ]
 const hashes={}
 for(const file of files) hashes[file]=createHash('sha256').update(await readFile(path.join(rootPath,file))).digest('hex')
 await writeJson('execution-source.json',{
  sourceRevision:revision,revisionIsCallerSupplied:true,node:process.versions.node,
  selectedInputSha256:hashes,
  scope:'Synthetic local PGlite and model stub; no provider, production, network service, or worker isolation validation.',
 })
 function importModule(file){return import(pathToFileURL(path.join(rootPath,file)).href)}
 async function writeJson(file,value){await writeFile(path.join(outputDir,file),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'})}
 return{revision,expect:values.expect,outputDir,importModule,writeJson}
}

export async function countsOnly(main){
 try{await main()}catch(error){
  // Do not print driver errors, exception messages, stacks, prompts, or row contents.
  const failureType=['AssertionError','TypeError','SyntaxError','RangeError'].includes(error?.name)?error.name:'Error'
  console.error(JSON.stringify({passed:false,failureType}))
  process.exitCode=1
 }
}
