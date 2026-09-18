import { spawnSync } from 'node:child_process'
import process from 'node:process'

/**
 * Vitest globalSetup:确保 better-sqlite3 在测试开始前处于 Node ABI。
 *
 * 与 scripts/prepare-native-for-node.mjs 的既有契约一致:ABI 已正确时是
 * 快速校验(毫秒级),不匹配时才触发重编。dev 方向由 predev 钩子自动切
 * Electron ABI,测试方向由本钩子自动切回,双向均无需手动干预。
 *
 * 非致命:dev 应用正在运行时会锁住 .node 文件导致重编失败(EBUSY)。
 * 此时仅警告并继续——不依赖 better-sqlite3 的测试仍可运行。
 */
export default function prepareNativeNodeForVitest() {
  const result = spawnSync(process.execPath, ['scripts/prepare-native-for-node.mjs'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
  if (result.error) {
    console.warn('[native-abi] prepare-native-for-node could not run:', result.error.message)
    return
  }
  if (result.status !== 0) {
    console.warn('[native-abi] prepare-native-for-node failed; better-sqlite3 may be on the wrong ABI — DB-backed tests will fail until the app is closed or the script succeeds.')
  }
}
