import { spawnSync } from 'node:child_process'
import process from 'node:process'

/**
 * Vitest globalSetup:确保 better-sqlite3 在测试开始前处于 Node ABI。
 *
 * 与 scripts/prepare-native-for-node.mjs 的既有契约一致:ABI 已正确时是
 * 快速校验(毫秒级),不匹配时才触发重编。dev 方向由 predev 钩子自动切
 * Electron ABI,测试方向由本钩子自动切回,双向均无需手动干预。
 */
export default function prepareNativeNodeForVitest() {
  const result = spawnSync(process.execPath, ['scripts/prepare-native-for-node.mjs'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`prepare-native-for-node failed with exit code ${result.status}`)
  }
}
