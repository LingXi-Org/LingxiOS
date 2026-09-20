import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

/** Stop the supervised Linux process tree, including all Python threads, while copying a checkpoint. */
export async function freezeKernel(pid: number, signal: AbortSignal): Promise<() => void> {
  if (process.platform !== 'linux') throw new Error('live kernel checkpoints require Linux process isolation')
  const stopped: number[] = []
  const resume = () => {
    for (const child of stopped.reverse()) {
      try { process.kill(child, 'SIGCONT') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }
  const stop = async (child: number, depth: number) => {
    signal.throwIfAborted()
    if (depth > 8 || stopped.length >= 128) throw new Error('kernel process tree exceeds checkpoint limits')
    process.kill(child, 'SIGSTOP'); stopped.push(child)
    for (;;) {
      signal.throwIfAborted()
      const status = await readFile(`/proc/${child}/status`, 'utf8')
      if (/^State:\s+[Tt]/m.test(status)) break
      await delay(5, undefined, { signal })
    }
    // A stopped parent cannot replace a child before we inspect and stop it.
    const children = (await readFile(`/proc/${child}/task/${child}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number)
    for (const descendant of children) {
      if (!Number.isSafeInteger(descendant) || descendant < 1) throw new Error('invalid kernel process tree')
      const status = await readFile(`/proc/${descendant}/status`, 'utf8')
      if (!new RegExp(`^PPid:\\s+${child}$`, 'm').test(status)) throw new Error('kernel process tree changed during checkpoint')
      await stop(descendant, depth + 1)
    }
  }
  try { await stop(pid, 0); return resume }
  catch (error) { resume(); throw error }
}
