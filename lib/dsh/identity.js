'use strict';
// dsh 设备身份与对端信任库（design-dsh-host-connection「账号与设备身份」）：
// - 设备身份：X25519 密钥对 → ~/.agentlray/dsh-device.json（公开信息）+ ~/.agentlray/dsh-device.key（私钥，0600）。
// - 信任库：~/.agentlray/dsh-trusted-peers.json（钉住对端设备公钥，防身份被替换）。
//
// 密钥生成与编码沿用借码层 @dsh-remote/crypto（与上游 ds-harness-remote 同格式：base64url
// 无填充），保证 Noise IK 握手、relay 服务器的 identityKey 字段与上游完全一致。
//
// 对外接口与上游 packages/plugin/src/identity-store.ts 的 IdentityStore 同构（借码层的
// 类型桩见 lib/dsh/vendor/src/plugin/identity-store.ts），使上游连接骨架可直接把它当作
// 身份存储使用；但落盘位置与文件名是 AgentLRay 自己的（不侵入上游 ~/.dsh 目录）。
const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { HOME } = require('../config');
const { loadVendor } = require('./vendor');

const AGENTLRAY_DIR = path.join(HOME, '.agentlray');
const DEVICE_FILE = path.join(AGENTLRAY_DIR, 'dsh-device.json');
const KEY_FILE = path.join(AGENTLRAY_DIR, 'dsh-device.key');
const PEERS_FILE = path.join(AGENTLRAY_DIR, 'dsh-trusted-peers.json');

// 设备身份按用途拆分（中继服务器对同一设备只保留一条控制连接，新连接会顶替旧连接，
// 因此「出站隧道」「连接测试」「被连接方」必须用不同设备身份，否则互相顶替）：
// - host ：本机作为被连接方（role=host）的身份，主设备身份。
// - client：出站隧道（role=client）的身份，所有出站隧道共用一条控制连接
//           （与「同一时刻只保留当前选中主机一条隧道」的既有模型一致）。
// - probe ：连接测试用的探测身份，独立设备，不影响正在使用的出站隧道。
const IDENTITY_SCOPES = {
  host: { deviceFile: 'dsh-device.json', keyFile: 'dsh-device.key', peersFile: 'dsh-trusted-peers.json' },
  client: { deviceFile: 'dsh-client.json', keyFile: 'dsh-client.key', peersFile: 'dsh-client-trusted-peers.json' },
  probe: { deviceFile: 'dsh-probe.json', keyFile: 'dsh-probe.key', peersFile: 'dsh-probe-trusted-peers.json' },
};

const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 读 JSON 文件；不存在/损坏 → undefined（调用方决定语义）。 */
async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 原子写（tmp + rename），0600 权限：身份/信任库含敏感材料。 */
async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, file);
  return data;
}

/** 公钥指纹（与上游 identity-store 的 fingerprint 同算法：sha256 前 6 字节大写分组）。 */
function fingerprint(publicKey) {
  const vendor = loadVendor();
  const bytes = vendor.crypto.fromBase64Url(publicKey);
  const compact = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12).toUpperCase();
  return compact.match(/.{1,4}/g).join(' ');
}

/**
 * dsh 身份存储：设备身份（自身）+ 信任库（对端）。
 * 方法签名与上游 IdentityStore 一致，供借码层连接骨架直接使用。
 */
class DshIdentityStore {
  constructor(options = {}) {
    this.deviceFile = options.deviceFile || DEVICE_FILE;
    this.keyFile = options.keyFile || KEY_FILE;
    this.peersFile = options.peersFile || PEERS_FILE;
    this.identity = undefined;
    this.peers = new Map();
  }

  /** 读取已有身份（不创建）。不存在 → undefined；不完整/损坏 → 抛错。 */
  async loadExisting() {
    const [device, key] = await Promise.all([readJson(this.deviceFile), this.readKeyFile()]);
    const hasDevice = device !== undefined;
    const hasKey = key !== undefined;
    if (!hasDevice && !hasKey) return undefined;
    if (hasDevice !== hasKey) {
      throw new Error('dsh 设备身份不完整（device.json 与 device.key 只存在其一），请手动修复后再连接');
    }
    return this.verify(device, key);
  }

  /** 读取（或首次生成）身份。deviceName 变化只更新展示名，不换密钥。 */
  async loadOrCreate(deviceName) {
    const existing = await this.loadExisting();
    if (existing) {
      if (deviceName && existing.name !== deviceName) {
        const updated = { ...existing, name: deviceName };
        await writeJsonAtomic(this.deviceFile, {
          schemaVersion: 1,
          deviceId: updated.deviceId,
          name: updated.name,
          publicKey: updated.publicKey,
        });
        this.identity = updated;
      }
      await this.loadPeers();
      return this.identity;
    }
    const vendor = loadVendor();
    const keys = vendor.crypto.generateKeyPair();
    const deviceId = vendor.ids.uuidV7();
    // 先写私钥再写公开信息：中途崩溃只会留下「不完整」状态（启动时明确报错），
    // 而不会出现「有公钥无私钥」的不可用身份。
    await fsp.mkdir(path.dirname(this.keyFile), { recursive: true });
    const keyTmp = `${this.keyFile}.tmp`;
    await fsp.writeFile(keyTmp, `${keys.privateKey}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(keyTmp, this.keyFile);
    await writeJsonAtomic(this.deviceFile, {
      schemaVersion: 1,
      deviceId,
      name: deviceName,
      publicKey: keys.publicKey,
    });
    const identity = this.verify(
      { schemaVersion: 1, deviceId, name: deviceName, publicKey: keys.publicKey },
      keys.privateKey
    );
    await this.loadPeers();
    return identity;
  }

  /** 当前身份（未加载则抛错）。 */
  current() {
    if (!this.identity) throw new Error('dsh 身份尚未加载');
    return this.identity;
  }

  listTrustedPeers() {
    return [...this.peers.values()].map((peer) => ({ ...peer }));
  }

  trustedPeer(deviceId) {
    const peer = this.peers.get(deviceId);
    return peer ? { ...peer } : undefined;
  }

  isTrusted(deviceId, publicKey) {
    return this.peers.get(deviceId)?.publicKey === publicKey;
  }

  /** 钉住一个对端设备（幂等 upsert）。 */
  async trustPeer(input) {
    this.current();
    const peer = {
      deviceId: input.deviceId,
      name: input.name,
      platform: input.platform,
      publicKey: input.publicKey,
      fingerprint: fingerprint(input.publicKey),
      trustedAt: Date.now(),
      ...(input.membershipId === undefined ? {} : { membershipId: input.membershipId }),
    };
    this.peers.set(peer.deviceId, peer);
    await this.savePeers();
    return { ...peer };
  }

  async revokePeer(deviceId) {
    const removed = this.peers.delete(deviceId);
    if (removed) await this.savePeers();
    return removed;
  }

  async readKeyFile() {
    try {
      const text = (await fsp.readFile(this.keyFile, 'utf8')).trim();
      return text || undefined;
    } catch {
      return undefined;
    }
  }

  /** 校验公私钥一致（防文件错配导致握手永远失败）。 */
  verify(device, privateKey) {
    const vendor = loadVendor();
    if (!device || typeof device !== 'object') throw new Error('dsh 设备身份文件损坏');
    if (!DEVICE_ID_RE.test(String(device.deviceId || ''))) throw new Error('dsh 设备身份文件损坏：deviceId 非法');
    if (typeof device.publicKey !== 'string' || !device.publicKey) throw new Error('dsh 设备身份文件损坏：缺少公钥');
    if (typeof privateKey !== 'string' || !privateKey) throw new Error('dsh 设备身份文件损坏：缺少私钥');
    const regenerated = vendor.crypto.generateKeyPair(vendor.crypto.fromBase64Url(privateKey));
    if (regenerated.publicKey !== device.publicKey) {
      throw new Error('dsh 设备身份的公钥与私钥不匹配，请手动修复');
    }
    const identity = {
      schemaVersion: 1,
      deviceId: device.deviceId,
      name: typeof device.name === 'string' && device.name ? device.name : 'agentlray',
      publicKey: device.publicKey,
      privateKey,
      fingerprint: fingerprint(device.publicKey),
    };
    this.identity = identity;
    return identity;
  }

  async loadPeers() {
    const parsed = await readJson(this.peersFile);
    const list = Array.isArray(parsed?.peers) ? parsed.peers : [];
    this.peers = new Map();
    for (const peer of list) {
      if (!peer || typeof peer.deviceId !== 'string' || typeof peer.publicKey !== 'string') continue;
      this.peers.set(peer.deviceId, { ...peer });
    }
  }

  async savePeers() {
    await writeJsonAtomic(this.peersFile, { schemaVersion: 1, peers: [...this.peers.values()] });
  }
}

/** 取某个用途的身份存储（host / client / probe）。 */
function identityStoreFor(scope) {
  const files = IDENTITY_SCOPES[scope] || IDENTITY_SCOPES.client;
  return new DshIdentityStore({
    deviceFile: path.join(AGENTLRAY_DIR, files.deviceFile),
    keyFile: path.join(AGENTLRAY_DIR, files.keyFile),
    peersFile: path.join(AGENTLRAY_DIR, files.peersFile),
  });
}

module.exports = {
  DEVICE_FILE,
  KEY_FILE,
  PEERS_FILE,
  IDENTITY_SCOPES,
  DshIdentityStore,
  identityStoreFor,
  fingerprint,
  readJson,
  writeJsonAtomic,
};
