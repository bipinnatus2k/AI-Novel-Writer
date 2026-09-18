/**
 * read_file — 读取项目内的文件内容（支持 offset 分页读取长文件）
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { validatePath } from './safe-path'
import { agentToolText, assertAgentProjectCurrent, requireAgentProject } from './project-context'

/** 单次返回的最大字符数；更长文件用 offset 分页读取。 */
const READ_WINDOW_CHARS = 12_000

export const readFileTool = buildAgentTool({
  name: 'read_file',
  description: '读取项目目录中实际存在的文本文件。故事架构保存在项目数据中，请使用 read_architecture 工具读取，不要假定存在架构文件路径。长文件返回内容被截断时，用 offset 参数继续读取后续部分。',
  descriptionEn: 'Read an existing text file in the project directory. Use read_architecture for story architecture stored in project data instead of assuming an architecture file path. If the returned content is truncated, continue with the offset parameter.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '相对于项目根目录且已存在的文件路径，例如 ".vela/project.json" 或用户已创建的文本文件。故事架构请使用 read_architecture。',
        descriptionEn: 'Path to an existing file relative to the project root, such as ".vela/project.json" or a user-created text file. Use read_architecture for story architecture.',
      },
      offset: {
        type: 'integer',
        description: '起始字符偏移（默认 0）。上次返回提示「已截断」时，把上次提示中的 offset 值传入即可继续读取。',
        descriptionEn: 'Character offset to start reading from (default 0). When the previous result was truncated, pass the offset from its notice to continue.',
      },
    },
    required: ['file_path'],
  },
  requiresConfirmation: false,
  execute: async (args, context) => {
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)
    const filePath = args.file_path as string
    const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0)
    const { project, projectSession } = requireAgentProject(context)

    // 路径安全校验
    const pathCheck = validatePath(project.path, filePath)
    if (!pathCheck.valid) {
      return { success: false, content: '', error: text(
        pathCheck.error,
        `The path "${filePath}" is outside the project directory. Only project files can be read.`,
      ) }
    }

    const result = await ipc.invokeWithProjectSession(projectSession, 'fs:read-file', pathCheck.fullPath, project.path)
    assertAgentProjectCurrent(context)
    if (!result.success) {
      const detail = result.error
      return {
        success: false,
        content: '',
        error: context?.writingLanguage === 'en-US' && /[\u3400-\u9fff]/u.test(detail ?? '')
          ? text('文件读取失败', 'Could not read the file')
          : detail ?? text('文件读取失败', 'Could not read the file'),
      }
    }

    const total = result.content.length
    if (offset >= total) {
      return { success: true, content: text(
        `[已到文件末尾：共 ${total} 字符，offset=${offset} 处没有更多内容。]`,
        `[End of file: ${total} characters total, nothing more at offset=${offset}.]`,
      ) }
    }

    const window = result.content.slice(offset, offset + READ_WINDOW_CHARS)
    const end = offset + window.length
    if (end >= total) {
      return { success: true, content: window }
    }

    const notice = text(
      `\n\n[已截断：本段为第 ${offset + 1}-${end} 字符，共 ${total} 字符。继续读取请用 offset=${end}。]`,
      `\n\n[Truncated: showing characters ${offset + 1}-${end} of ${total}. Continue with offset=${end}.]`,
    )
    return { success: true, content: window + notice }
  },
})
