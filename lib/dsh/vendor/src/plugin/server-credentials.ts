// Borrowed from ds-harness-remote (https://github.com/liguobao/ds-harness-remote)
// Upstream path: packages/plugin/src/server-credentials.ts
// Upstream commit: 4cd6b4351c2c4be84c889dd72f2c42622f1d4235 (2026-11-17)
// License: MIT — see lib/dsh/vendor/README.md

import { chmod, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { z } from 'zod'
import { uuidV7 } from './ids.js'

const credentialSchema = z.object({
  schemaVersion: z.literal(1),
  serverUrl: z.string().url(),
  deviceId: z.string().min(1),
  authorizationMethod: z.enum(['account', 'host_registration_code', 'owned_device', 'device_pairing']),
  accountKind: z.enum(['standard', 'device_only']).optional(),
  pairingRestricted: z.boolean().optional(),
  inboundOnly: z.boolean().optional(),
  account: z.string().min(1).max(254).optional(),
  accessToken: z.string().min(16),
  accessTokenExpiresAt: z.number().int().positive(),
  refreshToken: z.string().min(16),
  refreshTokenExpiresAt: z.number().int().positive(),
}).strict()

export interface ServerCredentials extends z.infer<typeof credentialSchema> {}

// PATCH(AgentLRay): 可注入硬链接实现。Android/PRoot、/sdcard(FUSE) 等环境不支持硬链接，
// 默认实现会让每次认证都抛 SERVER_CREDENTIALS_LOCK_UNSUPPORTED；带注入参数是为了让
// 这类现场可测试地降级（见 withQueueLock 的进程内互斥回退）。
export interface ServerCredentialStoreOptions {
  linkFile?: (existingPath: string, newPath: string) => Promise<void>
}

/** 进程内刷新队列（硬链接不可用时的回退），按锁路径串行。 */
const processQueues = new Map<string, Promise<void>>()

export class ServerCredentialStore {
  private readonly path: string
  private readonly linkFile: (existingPath: string, newPath: string) => Promise<void>

  constructor(directory: string, options: ServerCredentialStoreOptions = {}) {
    this.path = join(directory, 'server-credentials.json')
    this.linkFile = options.linkFile ?? link
  }

  /** Each process owns one queue record. A dead process cannot hold the queue. */
  async withRefreshLock<T>(operation: () => Promise<T>): Promise<T> {
    const gate = defaultMigrationGate(dirname(this.path))
    const run = () => withQueueLock(`${this.path}.refresh-lock`, operation, this.linkFile)
    return gate === undefined ? run() : withQueueLock(gate, run, this.linkFile)
  }

  async pairingHostOnly(): Promise<boolean> {
    const policy = await readPrivateJson(join(dirname(this.path), 'pairing-host-only.json'))
    if (policy === undefined) return false
    z.object({ hostOnly: z.literal(true) }).strict().parse(policy)
    return true
  }

  async restrictPairingHostOnly(): Promise<void> {
    await atomicWritePrivate(join(dirname(this.path), 'pairing-host-only.json'), '{"hostOnly":true}')
  }

  async load(serverUrl: string, deviceId: string): Promise<ServerCredentials | undefined> {
    if (!(await exists(this.path))) return undefined
    await assertPrivateMode(this.path)
    let parsed: ServerCredentials
    try {
      parsed = credentialSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      throw new ServerCredentialsInvalidError(`server credentials are invalid: ${safeMessage(error)}`)
    }
    return parsed.serverUrl === serverUrl && parsed.deviceId === deviceId ? parsed : undefined
  }

  async save(credentials: Omit<ServerCredentials, 'schemaVersion'>): Promise<ServerCredentials> {
    const record = credentialSchema.parse({ schemaVersion: 1, ...credentials })
    await atomicWritePrivate(this.path, `${JSON.stringify(record, null, 2)}\n`)
    return record
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true })
    await removeStaleRefreshQueue(`${this.path}.refresh-lock`)
  }
}

function defaultMigrationGate(directory: string): string | undefined {
  const parts = directory.split(sep)
  let rootIndex = -1
  for (let index = parts.length - 1; index >= 0; index--) {
    if ((parts[index] === 'remote' || parts[index] === 'ds-harness-remote')
      && (index === parts.length - 1 || parts[index + 1] === 'servers')) {
      rootIndex = index
      break
    }
  }
  if (rootIndex < 1) return undefined
  const suffix = parts.slice(rootIndex + 1)
  if (suffix.length !== 0 && (suffix.length !== 3 || suffix[0] !== 'servers'
    || !/^[a-f0-9]{24}$/.test(suffix[1]!) || !['host', 'client'].includes(suffix[2]!))) return undefined
  return join(parts.slice(0, rootIndex).join(sep) || sep, '.ds-harness-remote-migration', 'credential-refresh-gate')
}

export function withDefaultCredentialMigrationGate<T>(home: string, operation: () => Promise<T>): Promise<T> {
  return withQueueLock(join(home, '.ds-harness-remote-migration', 'credential-refresh-gate'), operation)
}

export async function assertRefreshQueueIdle(directory: string): Promise<void> {
  const lock = join(directory, 'server-credentials.json.refresh-lock')
  const marker = await readQueueMarker(lock)
  if (marker === undefined) {
    if ((await readdir(directory)).some(name => name.startsWith(`${basename(lock)}.holder-`) && !name.endsWith('.tmp'))) {
      throw new ServerCredentialsBusyError()
    }
    return
  }
  if (marker !== SERVER_CREDENTIALS_QUEUE_MARKER) throw new ServerCredentialsBusyError()
  if ((await participants(lock)).length > 0) throw new ServerCredentialsBusyError()
}

// PATCH(AgentLRay): 硬链接不可用时降级为进程内互斥，而不是让认证/拉设备列表直接失败。
// 触发条件仅限「获取文件锁阶段」失败（ServerCredentialsLockUnsupportedError）；operation
// 自身抛出的错误原样上抛，绝不重跑。注意：降级只保护同一进程，跨进程互斥在该文件系统上
// 本就不可得（上游对此直接报错）。
// Upstream: withQueueLock 直接抛 ServerCredentialsLockUnsupportedError。
async function withQueueLock<T>(
  lock: string,
  operation: () => Promise<T>,
  linkFile: (existingPath: string, newPath: string) => Promise<void> = link,
): Promise<T> {
  let acquired = false
  try {
    return await withFileQueueLock(lock, operation, linkFile, () => { acquired = true })
  } catch (error) {
    if (acquired || !(error instanceof ServerCredentialsLockUnsupportedError)) throw error
    return withProcessQueueLock(lock, operation)
  }
}

function withProcessQueueLock<T>(lock: string, operation: () => Promise<T>): Promise<T> {
  const previous = processQueues.get(lock) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const tail = result.then(() => undefined, () => undefined)
  processQueues.set(lock, tail)
  void tail.then(() => { if (processQueues.get(lock) === tail) processQueues.delete(lock) })
  return result
}

async function withFileQueueLock<T>(
  lock: string,
  operation: () => Promise<T>,
  linkFile: (existingPath: string, newPath: string) => Promise<void>,
  onAcquired: () => void,
): Promise<T> {
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 15_000
  await ensureQueueMarker(lock, deadline, linkFile)
  const id = `${process.pid}-${uuidV7()}`
  const holder = `${lock}.holder-${id}`
  // Publish intent first. A later contender must see this record before it chooses a ticket.
  await publishExclusive(holder, `${id} choosing\n`, linkFile)
  try {
    const ticket = 1 + (await participants(lock)).reduce((max, entry) => Math.max(max, entry.ticket ?? 0), 0)
    if (!Number.isSafeInteger(ticket)) throw new ServerCredentialsBusyError()
    await atomicWritePrivate(holder, `${id} ${ticket}\n`)
    for (;;) {
      const entries = await participants(lock)
      const preceding = entries.some(entry => entry.id !== id && (entry.ticket === undefined
        || entry.ticket < ticket || (entry.ticket === ticket && entry.id < id)))
      if (!preceding) break
      if (Date.now() >= deadline) throw new ServerCredentialsBusyError()
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    onAcquired()
    return await operation()
  } finally {
    await rm(holder, { force: true })
  }
}

export class ServerCredentialsInvalidError extends Error {
  readonly code = 'SERVER_CREDENTIALS_INVALID'
}

export class ServerCredentialsBusyError extends Error {
  readonly code = 'SERVER_CREDENTIALS_BUSY'
  constructor() {
    super('Credential refresh is busy. Stop other instances. Remove a legacy refresh lock only after every instance stops.')
  }
}

export class ServerCredentialsLockUnsupportedError extends Error {
  readonly code = 'SERVER_CREDENTIALS_LOCK_UNSUPPORTED'
  constructor() {
    super('Credential lock cannot create a hard link in DSH_HOME. Use a writable local ext4 or XFS file system.')
  }
}

export const SERVER_CREDENTIALS_QUEUE_MARKER = 'DSH_REFRESH_LOCK_V2\n'

async function ensureQueueMarker(
  lock: string,
  deadline: number,
  linkFile: (existingPath: string, newPath: string) => Promise<void>,
): Promise<void> {
  // Old versions use this path as their lock. Keep them outside the new queue.
  for (;;) {
    try {
      await publishExclusive(lock, SERVER_CREDENTIALS_QUEUE_MARKER, linkFile)
      return
    } catch (error) {
      if (!(await isLockContention(error, lock))) throw error
      if (await readQueueMarker(lock) === SERVER_CREDENTIALS_QUEUE_MARKER) return
      if (Date.now() >= deadline) throw new ServerCredentialsBusyError()
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

interface QueueParticipant { id: string; ticket?: number }

async function participants(lock: string): Promise<QueueParticipant[]> {
  const prefix = `${basename(lock)}.holder-`
  const entries = await readdir(dirname(lock))
  const result: QueueParticipant[] = []
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    if (name.endsWith('.tmp')) continue
    const id = name.slice(prefix.length)
    if (!/^\d+-[0-9a-f-]{36}$/.test(id)) throw new ServerCredentialsBusyError()
    const path = join(dirname(lock), name)
    const record = await readLockRecord(path)
    if (record === undefined) continue
    const match = new RegExp(`^${id} (choosing|[1-9]\\d*)\\n$`).exec(record)
    if (match === null) throw new ServerCredentialsBusyError()
    const pid = Number(id.slice(0, id.indexOf('-')))
    // A unique path cannot become a new owner's record. Dead records can leave the queue.
    if (await ownerExited(pid)) {
      await rm(path, { force: true })
      continue
    }
    const ticket = match[1] === 'choosing' ? undefined : Number(match[1])
    if (ticket !== undefined && !Number.isSafeInteger(ticket)) throw new ServerCredentialsBusyError()
    result.push({ id, ...(ticket === undefined ? {} : { ticket }) })
  }
  return result
}

async function publishExclusive(
  path: string,
  record: string,
  linkFile: (existingPath: string, newPath: string) => Promise<void>,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${uuidV7()}.tmp`
  await writeFile(temporary, record, { mode: 0o600, flag: 'wx' })
  try {
    try { await linkFile(temporary, path) } catch (error) {
      if (error instanceof Error && 'code' in error
        && ['EXDEV', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EPERM', 'EACCES'].includes(String(error.code))) {
        throw new ServerCredentialsLockUnsupportedError()
      }
      throw error
    }
  } finally { await rm(temporary, { force: true }) }
}

async function isLockContention(error: unknown, path: string): Promise<boolean> {
  if (!(error instanceof Error) || !('code' in error)) return false
  if (error.code === 'EEXIST') return true
  if (process.platform !== 'win32' || error.code !== 'EPERM') return false
  return exists(path)
}

async function readLockRecord(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function readQueueMarker(lock: string): Promise<string | undefined> {
  try { return await readLockRecord(lock) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EISDIR') return undefined
    throw error
  }
}

// PATCH(AgentLRay): clear() 顺带清理残留刷新队列文件（上游只删凭据文件，旧锁标记与
// 已死进程的 holder 会一直留在目录里，Android 现场因此积累无效锁）。
// 只删「已退出进程」的 holder；锁标记仅在没有存活 holder 时删除，避免破坏仍在运行的
// 其它实例之间的互斥。
async function removeStaleRefreshQueue(lock: string): Promise<void> {
  const directory = dirname(lock)
  if (!(await exists(directory))) return
  const prefix = `${basename(lock)}.holder-`
  let liveHolders = 0
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || name.endsWith('.tmp')) continue
    const id = name.slice(prefix.length)
    const separator = id.indexOf('-')
    const pid = separator > 0 ? Number(id.slice(0, separator)) : Number.NaN
    if (!Number.isSafeInteger(pid)) continue
    if (!(await ownerExited(pid))) { liveHolders += 1; continue }
    await rm(join(directory, name), { force: true })
  }
  if (liveHolders === 0 && (await readQueueMarker(lock)) !== undefined) await rm(lock, { force: true })
}

async function ownerExited(pid: number): Promise<boolean> {
  if (pid < 1 || pid > 2147483647 || pid === process.pid) return false
  try { process.kill(pid, 0); return false } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

export async function atomicWritePrivate(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${uuidV7()}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
  await chmod(path, 0o600)
}

async function assertPrivateMode(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const mode = (await stat(path)).mode & 0o777
  if ((mode & 0o077) !== 0) throw new ServerCredentialsInvalidError('server credentials permissions must be 0600')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function safeMessage(error: unknown): string { return error instanceof Error ? error.message : 'invalid credential data' }

export async function readPrivateJson(path: string): Promise<unknown | undefined> {
  if (!await exists(path)) return undefined
  await assertPrivateMode(path)
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
